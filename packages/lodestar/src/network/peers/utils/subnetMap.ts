import {IForkName} from "@chainsafe/lodestar-config";
import {Slot} from "@chainsafe/lodestar-types";

export type RequestedSubnet = {
  subnetId: number;
  /**
   * Slot after which the network will stop maintaining a min number of peers
   * connected to `subnetId`
   */
  toSlot: Slot;
};

/**
 * Track requested subnets by `toSlot`
 */
export class SubnetMap {
  /** Map of subnets and the slot until they are needed */
  private subnets = new Map<number, Slot>();
  private forkName: IForkName;
  constructor(forkName: IForkName) {
    this.forkName = forkName;
  }

  /**
   * Register requested subnets, extends toSlot if same subnet.
   **/
  request(requestedSubnet: RequestedSubnet): void {
    const {subnetId, toSlot} = requestedSubnet;
    this.subnets.set(subnetId, Math.max(this.subnets.get(subnetId) || 0, toSlot));
  }

  /**
   * Get last active slot of a subnet.
   */
  getToSlot(subnet: number): number | undefined {
    return this.subnets.get(subnet);
  }

  /**
   * Get fork name
   */
  getForkName(): IForkName {
    return this.forkName;
  }

  /** Return subnetIds with a `toSlot` equal greater than `currentSlot` */
  getActive(currentSlot: Slot): number[] {
    return this.getSubnets(currentSlot, (toSlot: Slot, currentSlot: Slot) => toSlot >= currentSlot);
  }

  /** Return subnetIds with a `toSlot` less than `currentSlot` */
  getInactive(currentSlot: Slot): number[] {
    return this.getSubnets(currentSlot, (toSlot: Slot, currentSlot: Slot) => toSlot < currentSlot);
  }

  getAll(): number[] {
    return Array.from(this.subnets.keys());
  }

  prune(subnet: number): void {
    this.subnets.delete(subnet);
  }

  /** Return subnetIds with a `toSlot` equal greater than `currentSlot` */
  private getSubnets(currentSlot: Slot, predicate: (toSlot: Slot, currentSlot: Slot) => boolean): number[] {
    const activeSubnetIds: number[] = [];

    for (const [subnetId, toSlot] of this.subnets.entries()) {
      if (predicate(toSlot, currentSlot)) {
        activeSubnetIds.push(subnetId);
      }
    }

    return activeSubnetIds;
  }
}
