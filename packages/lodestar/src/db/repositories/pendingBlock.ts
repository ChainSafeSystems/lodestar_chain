import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {Bucket, IDatabaseController, IDbMetrics, Repository} from "@chainsafe/lodestar-db";
import {allForks, ssz} from "@chainsafe/lodestar-types";
import {getSignedBlockTypeFromBytes} from "../../util/multifork";

/**
 * Blocks by root
 *
 * Used to store pending blocks
 */
export class PendingBlockRepository extends Repository<Uint8Array, allForks.SignedBeaconBlock> {
  constructor(config: IChainForkConfig, db: IDatabaseController<Buffer, Buffer>, metrics?: IDbMetrics) {
    const type = ssz.phase0.SignedBeaconBlock; // Pick some type but won't be used
    super(config, db, Bucket.allForks_pendingBlock, type, metrics);
  }

  /**
   * Id is hashTreeRoot of unsigned BeaconBlock
   */
  getId(value: allForks.SignedBeaconBlock): Uint8Array {
    return this.config.getForkTypes(value.message.slot).BeaconBlock.hashTreeRoot(value.message);
  }

  encodeValue(value: allForks.SignedBeaconBlock): Buffer {
    return this.config.getForkTypes(value.message.slot).SignedBeaconBlock.serialize(value) as Buffer;
  }

  decodeValue(data: Buffer): allForks.SignedBeaconBlock {
    return getSignedBlockTypeFromBytes(this.config, data).createTreeBackedFromBytes(data);
  }
}
