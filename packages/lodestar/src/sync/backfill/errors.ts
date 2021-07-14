import PeerId from "peer-id";
import {Root} from "@chainsafe/lodestar-types";
import {LodestarError} from "../../../../utils/lib";

export enum BackfillSyncErrorCode {
  //fetched block doesn't connect to anchor block
  NOT_ANCHORED = "not_anchored",
  // fetched blocks are not linear
  NOT_LINEAR = "not_linear",
  // peer doesn't have required blocks
  MISSING_BLOCKS = "mssing_blocks",
  INVALID_SIGNATURE = "invalid_proposer_signature",
}

export type BackfillSyncErrorType =
  | {code: BackfillSyncErrorCode.NOT_ANCHORED}
  | {code: BackfillSyncErrorCode.NOT_LINEAR}
  | {code: BackfillSyncErrorCode.INVALID_SIGNATURE}
  | {code: BackfillSyncErrorCode.MISSING_BLOCKS; roots: Root[]; peerId: PeerId};

export class BackfillSyncError extends LodestarError<BackfillSyncErrorType> {}
