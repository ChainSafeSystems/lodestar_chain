import {AbortController, AbortSignal} from "abort-controller";
import {SecretKey} from "@chainsafe/bls";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Genesis} from "@chainsafe/lodestar-types/phase0";
import {fromHex, ILogger} from "@chainsafe/lodestar-utils";
import {getClient, Api} from "@chainsafe/lodestar-api";
import {Clock, IClock} from "./util/clock";
import {signAndSubmitVoluntaryExit} from "./voluntaryExit";
import {waitForGenesis} from "./genesis";
import {ValidatorStore} from "./services/validatorStore";
import {BlockProposingService} from "./services/block";
import {AttestationService} from "./services/attestation";
import {IndicesService} from "./services/indices";
import {SyncCommitteeService} from "./services/syncCommittee";
import {ISlashingProtection} from "./slashingProtection";
import {assertEqualParams} from "./util/params";

export type ValidatorOptions = {
  slashingProtection: ISlashingProtection;
  config: IBeaconConfig;
  api: Api | string;
  secretKeys: SecretKey[];
  logger: ILogger;
  graffiti?: string;
};

// TODO: Extend the timeout, and let it be customizable
/// The global timeout for HTTP requests to the beacon node.
// const HTTP_TIMEOUT_MS = 12 * 1000;

enum Status {
  running,
  stopped,
}

type State = {status: Status.running; controller: AbortController} | {status: Status.stopped};

/**
 * Main class for the Validator client.
 */
export class Validator {
  private readonly config: IBeaconConfig;
  private readonly api: Api;
  private readonly secretKeys: SecretKey[];
  private readonly clock: IClock;
  private readonly logger: ILogger;
  private state: State = {status: Status.stopped};

  constructor(opts: ValidatorOptions, genesis: Genesis) {
    const {config, logger, slashingProtection, secretKeys, graffiti} = opts;

    const api =
      typeof opts.api === "string"
        ? getClient(config, {
            baseUrl: opts.api,
            timeoutMs: config.params.SECONDS_PER_SLOT * 1000,
            getAbortSignal: this.getAbortSignal,
          })
        : opts.api;

    const clock = new Clock(config, logger, {genesisTime: Number(genesis.genesisTime)});
    const validatorStore = new ValidatorStore(config, slashingProtection, secretKeys, genesis);
    const indicesService = new IndicesService(logger, api, validatorStore);
    new BlockProposingService(config, logger, api, clock, validatorStore, graffiti);
    new AttestationService(config, logger, api, clock, validatorStore, indicesService);
    new SyncCommitteeService(config, logger, api, clock, validatorStore, indicesService);

    this.config = config;
    this.logger = logger;
    this.api = api;
    this.clock = clock;
    this.secretKeys = secretKeys;
  }

  /** Waits for genesis and genesis time */
  static async initializeFromBeaconNode(opts: ValidatorOptions, signal?: AbortSignal): Promise<Validator> {
    const api =
      typeof opts.api === "string"
        ? getClient(opts.config, {baseUrl: opts.api, timeoutMs: 12000, getAbortSignal: () => signal})
        : opts.api;

    const genesis = await waitForGenesis(api, opts.logger, signal);
    opts.logger.info("Genesis available");

    const {data: nodeParams} = await api.config.getSpec();
    assertEqualParams(opts.config.params, nodeParams);
    opts.logger.info("Verified node and validator have same config");

    return new Validator(opts, genesis);
  }

  /**
   * Instantiates block and attestation services and runs them once the chain has been started.
   */
  async start(): Promise<void> {
    if (this.state.status === Status.running) return;
    const controller = new AbortController();
    this.state = {status: Status.running, controller};

    this.clock.start(controller.signal);
  }

  /**
   * Stops all validator functions.
   */
  async stop(): Promise<void> {
    if (this.state.status === Status.stopped) return;
    this.state.controller.abort();
    this.state = {status: Status.stopped};
  }

  /**
   * Perform a voluntary exit for the given validator by its key.
   */
  async voluntaryExit(publicKey: string, exitEpoch: number): Promise<void> {
    const secretKey = this.secretKeys.find((sk) =>
      this.config.types.BLSPubkey.equals(sk.toPublicKey().toBytes(), fromHex(publicKey))
    );
    if (!secretKey) throw new Error(`No matching secret key found for public key ${publicKey}`);

    await signAndSubmitVoluntaryExit(publicKey, exitEpoch, secretKey, this.api, this.config);
    this.logger.info(`Submitted voluntary exit for ${publicKey} to the network`);
  }

  /** Provide the current AbortSignal to the api instance */
  private getAbortSignal = (): AbortSignal | undefined => {
    return this.state.status === Status.running ? this.state.controller.signal : undefined;
  };
}
