import url from "url";
import path from "path";
import { bold, dim } from "colorette";
import { spawn } from "child_process";
import {
  DescribeStacksCommand,
  CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import {
  App,
  DefaultStackSynthesizer,
  CfnOutput,
  Duration,
  Tags,
  Stack,
  RemovalPolicy,
} from "aws-cdk-lib";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Rule } from "aws-cdk-lib/aws-events";
import { SqsQueue } from "aws-cdk-lib/aws-events-targets";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { useProject } from "./project.js";
import { createSpinner } from "./cli/spinner.js";
import { Context } from "./context/context.js";
import {
  useAWSClient,
  useAWSCredentials,
  useSTSIdentity,
} from "./credentials.js";
import { VisibleError } from "./error.js";
import { Logger } from "./logger.js";
import { Stacks } from "./stacks/index.js";

const STACK_NAME = "SSTBootstrap";
const OUTPUT_VERSION = "Version";
const OUTPUT_BUCKET = "BucketName";
const LATEST_VERSION = "7";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export const useBootstrap = Context.memo(async () => {
  Logger.debug("Initializing bootstrap context");
  let [cdkStatus, sstStatus] = await Promise.all([
    loadCDKStatus(),
    loadSSTStatus(),
  ]);
  Logger.debug("Loaded bootstrap status");
  const needToBootstrapCDK = !cdkStatus;
  const needToBootstrapSST = !sstStatus || sstStatus.version !== LATEST_VERSION;

  if (needToBootstrapCDK || needToBootstrapSST) {
    const spinner = createSpinner(
      "Deploying bootstrap stack, this only needs to happen once"
    ).start();

    if (needToBootstrapCDK) {
      await bootstrapCDK();
    }
    if (needToBootstrapSST) {
      await bootstrapSST();

      // fetch bootstrap status
      sstStatus = await loadSSTStatus();
      if (!sstStatus)
        throw new VisibleError("Failed to load bootstrap stack status");
    }
    spinner.succeed();
  }

  Logger.debug("Bootstrap context initialized", sstStatus);
  return sstStatus as {
    version: string;
    bucket: string;
  };
}, "Bootstrap");

async function loadCDKStatus() {
  const client = useAWSClient(CloudFormationClient);
  try {
    const { Stacks: stacks } = await client.send(
      new DescribeStacksCommand({
        StackName: "CDKToolkit",
      })
    );
    // Check CDK bootstrap stack exists
    if (!stacks || stacks.length === 0) return false;

    // Check CDK bootstrap stack deployed successfully
    if (
      !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stacks[0].StackStatus!)
    ) {
      return false;
    }

    // Check CDK bootstrap stack is up to date
    // note: there is no a programmatical way to get the minimal required version
    //       of CDK bootstrap stack. We are going to hardcode it to 14 for now,
    //       which is the latest version as of CDK v2.62.2
    const output = stacks[0].Outputs?.find(
      (o) => o.OutputKey === "BootstrapVersion"
    );
    if (!output || parseInt(output.OutputValue!) < 14) return false;

    return true;
  } catch (e: any) {
    if (
      e.name === "ValidationError" &&
      e.message === "Stack with id CDKToolkit does not exist"
    ) {
      return false;
    } else {
      throw e;
    }
  }
}

export async function bootstrapSST(
  tags?: Record<string, string>,
  publicAccessBlockConfiguration?: boolean,
  qualifier?: string
) {
  // Normalize input
  tags = tags || {};
  publicAccessBlockConfiguration =
    publicAccessBlockConfiguration === false ? false : true;

  // Create bootstrap stack
  const project = useProject();
  const app = new App();
  const stack = new Stack(app, STACK_NAME, {
    env: {
      region: project.config.region,
    },
    synthesizer: new DefaultStackSynthesizer({
      qualifier,
    }),
  });

  // Add tags to stack
  for (const [key, value] of Object.entries(tags)) {
    Tags.of(app).add(key, value);
  }

  // Create S3 bucket to store stacks metadata
  const bucket = new Bucket(stack, project.config.region!, {
    encryption: BucketEncryption.S3_MANAGED,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    blockPublicAccess: publicAccessBlockConfiguration
      ? BlockPublicAccess.BLOCK_ALL
      : undefined,
  });

  // Create Function and subscribe to CloudFormation events
  const fn = new Function(stack, "MetadataHandler", {
    code: Code.fromAsset(
      path.resolve(__dirname, "support/bootstrap-metadata-function")
    ),
    handler: "index.handler",
    runtime: project.config.region?.startsWith("us-gov-")
      ? Runtime.NODEJS_16_X
      : Runtime.NODEJS_18_X,
    environment: {
      BUCKET_NAME: bucket.bucketName,
    },
    initialPolicy: [
      new PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: ["*"],
      }),
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [bucket.bucketArn + "/*"],
      }),
      new PolicyStatement({
        actions: ["iot:Publish"],
        resources: [
          `arn:${stack.partition}:iot:${stack.region}:${stack.account}:topic//sst/*`,
        ],
      }),
    ],
  });
  const queue = new Queue(stack, "MetadataQueue", {
    visibilityTimeout: Duration.seconds(30),
    retentionPeriod: Duration.minutes(2),
  });
  fn.addEventSource(new SqsEventSource(queue));
  const rule = new Rule(stack, "MetadataRule", {
    eventPattern: {
      source: ["aws.cloudformation"],
      detailType: ["CloudFormation Stack Status Change"],
      detail: {
        "status-details": {
          status: [
            "CREATE_COMPLETE",
            "UPDATE_COMPLETE",
            "UPDATE_ROLLBACK_COMPLETE",
            "ROLLBACK_COMPLETE",
            "DELETE_COMPLETE",
          ],
        },
      },
    },
  });
  rule.addTarget(
    new SqsQueue(queue, {
      retryAttempts: 10,
    })
  );

  // Create stack outputs to store bootstrap stack info
  new CfnOutput(stack, OUTPUT_VERSION, { value: LATEST_VERSION });
  new CfnOutput(stack, OUTPUT_BUCKET, { value: bucket.bucketName });

  // Deploy bootstrap stack
  const asm = app.synth();
  const result = await Stacks.deploy(asm.stacks[0]);
  if (Stacks.isFailed(result.status)) {
    throw new VisibleError(
      `Failed to deploy bootstrap stack:\n${JSON.stringify(
        result.errors,
        null,
        4
      )}`
    );
  }
}

async function bootstrapCDK() {
  const identity = await useSTSIdentity();
  const credentials = await useAWSCredentials();
  const { region, profile } = useProject().config;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      [
        "npx",
        "cdk",
        "bootstrap",
        `aws://${identity.Account!}/${region}`,
        "--no-version-reporting",
      ].join(" "),
      {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
          AWS_SESSION_TOKEN: credentials.sessionToken,
          AWS_REGION: region,
          AWS_PROFILE: profile,
        },
        stdio: "pipe",
        shell: true,
      }
    );
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      Logger.debug(data.toString());
    });
    proc.stderr.on("data", (data: Buffer) => {
      Logger.debug(data.toString());
      stderr += data;
    });
    proc.on("exit", (code) => {
      Logger.debug("CDK bootstrap exited with code " + code);
      if (code === 0) {
        resolve();
      } else {
        console.log(bold(dim(stderr)));
        reject(new VisibleError(`Failed to bootstrap`));
      }
    });
  });
}

async function loadSSTStatus() {
  // Get bootstrap CloudFormation stack
  const cf = useAWSClient(CloudFormationClient);
  let result;
  try {
    result = await cf.send(
      new DescribeStacksCommand({
        StackName: STACK_NAME,
      })
    );
  } catch (e: any) {
    if (
      e.Code === "ValidationError" &&
      e.message === `Stack with id ${STACK_NAME} does not exist`
    ) {
      return null;
    }
    throw e;
  }

  // Parse stack outputs
  let version, bucket;
  (result.Stacks![0].Outputs || []).forEach((o) => {
    if (o.OutputKey === OUTPUT_VERSION) {
      version = o.OutputValue;
    } else if (o.OutputKey === OUTPUT_BUCKET) {
      bucket = o.OutputValue;
    }
  });
  if (!version || !bucket) {
    return null;
  }

  return { version, bucket };
}
