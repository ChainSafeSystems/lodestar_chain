import {createIBeaconParams} from "../../utils";
import {IBeaconParams} from "../../interface";

import {phase0Json} from "./phase0";
import {altairJson} from "./altair";
import {phase1Json} from "./phase1";

export const commit = "v1.1.0-alpha.2";

export const params = createIBeaconParams({
  ...phase0Json,
  ...altairJson,
  ...phase1Json,
}) as IBeaconParams;