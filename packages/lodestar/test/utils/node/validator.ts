import tmp from "tmp";
import {LevelDbController} from "@chainsafe/lodestar-db";
import {interopSecretKey} from "@chainsafe/lodestar-beacon-state-transition";
import {SlashingProtection, Validator, IValidatorOptions} from "@chainsafe/lodestar-validator";
import {BeaconNode} from "../../../src/node";
import {testLogger, TestLoggerOpts} from "../logger";

export async function getAndInitDevValidators({
  node,
  validatorsPerClient = 8,
  validatorClientCount = 1,
  startIndex = 0,
  useRestApi,
  testLoggerOpts,
  validatorOpts,
}: {
  node: BeaconNode;
  validatorsPerClient: number;
  validatorClientCount: number;
  startIndex: number;
  useRestApi?: boolean;
  testLoggerOpts?: TestLoggerOpts;
  validatorOpts?: IValidatorOptions;
}): Promise<Validator[]> {
  const vcs: Promise<Validator>[] = [];
  for (let i = 0; i < validatorClientCount; i++) {
    const startIndexVc = startIndex + i * validatorClientCount;
    const endIndex = startIndexVc + validatorsPerClient - 1;
    const logger = testLogger(`Vali ${startIndexVc}-${endIndex}`, testLoggerOpts);

    const tmpDir = tmp.dirSync({unsafeCleanup: true});
    vcs.push(
      Validator.initializeFromBeaconNode({
        opts: validatorOpts,
        config: node.config,
        api: useRestApi ? getNodeApiUrl(node) : node.api,
        slashingProtection: new SlashingProtection({
          config: node.config,
          controller: new LevelDbController({name: tmpDir.name}, {logger}),
        }),
        logger,
        secretKeys: Array.from({length: validatorsPerClient}, (_, i) => interopSecretKey(i + startIndexVc)),
      })
    );
  }

  return await Promise.all(vcs);
}

function getNodeApiUrl(node: BeaconNode): string {
  const host = node.opts.api.rest.host || "127.0.0.1";
  const port = node.opts.api.rest.port || 9596;
  return `http://${host}:${port}`;
}
