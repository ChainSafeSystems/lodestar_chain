import {Gauge, GaugeConfiguration} from "prom-client";
import {IGauge} from "../interface";

type CollectFn<T extends string> = (metric: IGauge<T>) => void;
type Labels<T extends string> = Partial<Record<T, string | number>>;

/**
 * Extends the prom-client Gauge with extra features:
 * - Add multiple collect functions after instantiation
 * - Create child gauges with fixed labels
 */
export class GaugeExtra<T extends string> extends Gauge<T> implements IGauge {
  private collectFns: CollectFn<T>[] = [];

  constructor(configuration: GaugeConfiguration<T>) {
    super(configuration);
  }

  addCollect(collectFn: CollectFn<T>): void {
    this.collectFns.push(collectFn);
  }

  child(labels: Labels<T>): GaugeChild<T> {
    return new GaugeChild(labels, this);
  }

  /**
   * @override Metric.collect
   */
  private collect(): void {
    for (const collectFn of this.collectFns) {
      collectFn(this);
    }
  }
}

export class GaugeChild<T extends string> implements IGauge {
  gauge: GaugeExtra<T>;
  labelsParent: Labels<T>;
  constructor(labelsParent: Labels<T>, gauge: GaugeExtra<T>) {
    this.gauge = gauge;
    this.labelsParent = labelsParent;
  }

  // Sorry for this mess, `prom-client` API choices are not great
  // If the function signature was `inc(value: number, labels?: Labels)`, this would be simpler
  inc(value?: number): void;
  inc(labels: Labels<T>, value?: number): void;
  inc(arg1?: Labels<T> | number, arg2?: number): void {
    if (typeof arg1 === "object") {
      this.gauge.inc({...this.labelsParent, ...arg1}, arg2 ?? 1);
    } else {
      this.gauge.inc(this.labelsParent, arg1 ?? 1);
    }
  }

  set(value: number): void;
  set(labels: Labels<T>, value: number): void;
  set(arg1?: Labels<T> | number, arg2?: number): void {
    if (typeof arg1 === "object") {
      this.gauge.set({...this.labelsParent, ...arg1}, arg2 || 0);
    } else {
      this.gauge.set(this.labelsParent, arg1 || 0);
    }
  }

  addCollect(collectFn: CollectFn<T>): void {
    this.gauge.addCollect(() => collectFn(this));
  }
}
