import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {Json} from "@chainsafe/ssz";
import {HttpClient, urlJoin} from "../../../../util";
import {IBeaconApi, IBeaconBlocksApi, IBeaconStateApi, IBeaconPoolApi} from "../../../interface/beacon";
import {RestBeaconBlocksApi} from "./blocks";
import {RestBeaconStateApi} from "./state";
import {RestBeaconPoolApi} from "./pool";

export class RestBeaconApi implements IBeaconApi {
  readonly state: IBeaconStateApi;
  readonly blocks: IBeaconBlocksApi;
  readonly pool: IBeaconPoolApi;

  private readonly clientV2: HttpClient;
  private readonly logger: ILogger;
  private readonly config: IBeaconConfig;

  constructor(config: IBeaconConfig, restUrl: string, logger: ILogger) {
    this.clientV2 = new HttpClient({urlPrefix: urlJoin(restUrl, "/eth/v1/beacon")}, {logger});
    this.logger = logger;
    this.config = config;
    this.state = new RestBeaconStateApi(this.config, this.clientV2, this.logger);
    this.blocks = new RestBeaconBlocksApi(this.config, this.clientV2, this.logger);
    this.pool = new RestBeaconPoolApi(this.config, this.clientV2, this.logger);
  }

  async getGenesis(): Promise<phase0.Genesis | null> {
    try {
      const genesisResponse = await this.clientV2.get<{data: Json}>("/genesis");
      return this.config.types.phase0.Genesis.fromJson(genesisResponse.data, {case: "snake"});
    } catch (e: unknown) {
      this.logger.error("Failed to obtain genesis time", {error: e.message});
      return null;
    }
  }

  async getChainHead(): Promise<phase0.BeaconBlock> {
    throw new Error("Method not implemented.");
  }
  async getBeaconState(): Promise<phase0.BeaconState> {
    throw new Error("Method not implemented.");
  }
}
