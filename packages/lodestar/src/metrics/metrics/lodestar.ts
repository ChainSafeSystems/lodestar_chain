import {allForks} from "@chainsafe/lodestar-types";
import {RegistryMetricCreator} from "../utils/registryMetricCreator";
import {IMetricsOptions} from "../options";

export type ILodestarMetrics = ReturnType<typeof createLodestarMetrics>;

/**
 * Extra Lodestar custom metrics
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/explicit-function-return-type
export function createLodestarMetrics(
  register: RegistryMetricCreator,
  metadata: IMetricsOptions["metadata"],
  anchorState?: allForks.BeaconState
) {
  if (metadata) {
    register.static<"semver" | "branch" | "commit" | "version" | "network">({
      name: "lodestar_version",
      help: "Lodestar version",
      value: metadata,
    });
  }

  // Initial static metrics
  if (anchorState) {
    register
      .gauge({
        name: "lodestar_genesis_time",
        help: "Genesis time in seconds",
      })
      .set(anchorState.genesisTime);
  }

  return {
    clockSlot: register.gauge({
      name: "lodestar_clock_slot",
      help: "Current clock slot",
    }),

    // Peers

    peersByDirection: register.gauge<"direction">({
      name: "lodestar_peers_by_direction",
      help: "number of peers, labeled by direction",
      labelNames: ["direction"],
    }),
    peerConnectedEvent: register.gauge<"direction">({
      name: "lodestar_peer_connected",
      help: "Number of peer:connected event, labeled by direction",
      labelNames: ["direction"],
    }),
    peerDisconnectedEvent: register.gauge<"direction">({
      name: "lodestar_peer_disconnected",
      help: "Number of peer:disconnected event, labeled by direction",
      labelNames: ["direction"],
    }),
    peerGoodbyeReceived: register.gauge<"reason">({
      name: "lodestar_peer_goodbye_received",
      help: "Number of goodbye received, labeled by reason",
      labelNames: ["reason"],
    }),
    peerGoodbyeSent: register.gauge<"reason">({
      name: "lodestar_peer_goodbye_sent",
      help: "Number of goodbye sent, labeled by reason",
      labelNames: ["reason"],
    }),
    peersTotalUniqueConnected: register.gauge({
      name: "lodestar_peers_total_unique_connected",
      help: "Total number of unique peers that have had a connection with",
    }),

    gossipMeshPeersByType: register.gauge<"type" | "fork">({
      name: "lodestar_gossip_mesh_peers_by_type",
      help: "Number of connected mesh peers per gossip type",
      labelNames: ["type", "fork"],
    }),
    gossipMeshPeersByBeaconAttestationSubnet: register.gauge<"subnet" | "fork">({
      name: "lodestar_gossip_mesh_peers_by_beacon_attestation_subnet",
      help: "Number of connected mesh peers per beacon attestation subnet",
      labelNames: ["subnet", "fork"],
    }),
    gossipMeshPeersBySyncCommitteeSubnet: register.gauge<"subnet" | "fork">({
      name: "lodestar_gossip_mesh_peers_by_sync_committee_subnet",
      help: "Number of connected mesh peers per sync committee subnet",
      labelNames: ["subnet", "fork"],
    }),

    gossipValidationAccept: register.gauge<"topic">({
      name: "lodestar_gossip_validation_accept",
      help: "Count of total gossip validation accept",
      labelNames: ["topic"],
    }),
    gossipValidationIgnore: register.gauge<"topic">({
      name: "lodestar_gossip_validation_ignore",
      help: "Count of total gossip validation ignore",
      labelNames: ["topic"],
    }),
    gossipValidationReject: register.gauge<"topic">({
      name: "lodestar_gossip_validation_reject",
      help: "Count of total gossip validation reject",
      labelNames: ["topic"],
    }),

    gossipValidationQueueLength: register.gauge<"topic">({
      name: "lodestar_gossip_validation_queue_length",
      help: "Count of total gossip validation queue length",
      labelNames: ["topic"],
    }),
    gossipValidationQueueDroppedJobs: register.gauge<"topic">({
      name: "lodestar_gossip_validation_queue_dropped_jobs_total",
      help: "Count of total gossip validation queue dropped jobs",
      labelNames: ["topic"],
    }),
    gossipValidationQueueJobTime: register.histogram<"topic">({
      name: "lodestar_gossip_validation_queue_job_time_seconds",
      help: "Time to process gossip validation queue job in seconds",
      labelNames: ["topic"],
    }),
    gossipValidationQueueJobWaitTime: register.histogram<"topic">({
      name: "lodestar_gossip_validation_queue_job_wait_time_seconds",
      help: "Time from job added to the queue to starting the job in seconds",
      labelNames: ["topic"],
      buckets: [0.1, 1, 10, 100],
    }),

    regenQueue: {
      length: register.gauge({
        name: "lodestar_regen_queue_length",
        help: "Count of total regen queue length",
      }),
      droppedJobs: register.gauge({
        name: "lodestar_regen_queue_dropped_jobs_total",
        help: "Count of total regen queue dropped jobs",
      }),
      jobTime: register.histogram({
        name: "lodestar_regen_queue_job_time_seconds",
        help: "Time to process regen queue job in seconds",
        buckets: [0.1, 1, 10, 100],
      }),
      jobWaitTime: register.histogram({
        name: "lodestar_regen_queue_job_wait_time_seconds",
        help: "Time from job added to the regen queue to starting in seconds",
        buckets: [0.1, 1, 10, 100],
      }),
    },

    blockProcessorQueue: {
      length: register.gauge({
        name: "lodestar_block_processor_queue_length",
        help: "Count of total block processor queue length",
      }),
      droppedJobs: register.gauge({
        name: "lodestar_block_processor_queue_dropped_jobs_total",
        help: "Count of total block processor queue dropped jobs",
      }),
      jobTime: register.histogram({
        name: "lodestar_block_processor_queue_job_time_seconds",
        help: "Time to process block processor queue job in seconds",
      }),
      jobWaitTime: register.histogram({
        name: "lodestar_block_processor_queue_job_wait_time_seconds",
        help: "Time from job added to the block processor queue to starting in seconds",
        buckets: [0.1, 1, 10, 100],
      }),
    },

    apiRestResponseTime: register.histogram<"operationId">({
      name: "lodestar_api_rest_response_time_seconds",
      help: "Time to fullfill a request to the REST api labeled by operationId",
      labelNames: ["operationId"],
      // Request times range between 1ms to 100ms in normal conditions. Can get to 1-5 seconds if overloaded
      buckets: [0.01, 0.1, 0.5, 1, 5, 10],
    }),

    // Beacon state transition metrics

    stfnEpochTransition: register.histogram({
      name: "lodestar_stfn_epoch_transition_seconds",
      help: "Time to process a single epoch transition in seconds",
      buckets: [0.1, 1, 10],
    }),
    stfnProcessBlock: register.histogram({
      name: "lodestar_stfn_process_block_seconds",
      help: "Time to process a single block in seconds",
      buckets: [0.1, 1, 10],
    }),

    // BLS verifier thread pool and queue

    blsThreadPool: {
      jobsWorkerTime: register.gauge<"workerId">({
        name: "lodestar_bls_thread_pool_time_seconds_sum",
        help: "Total time spent verifying signature sets measured on the worker",
        labelNames: ["workerId"],
      }),
      successJobsSignatureSetsCount: register.gauge({
        name: "lodestar_bls_thread_pool_success_jobs_signature_sets_count",
        help: "Count of total verified signature sets",
      }),
      errorJobsSignatureSetsCount: register.gauge({
        name: "lodestar_bls_thread_pool_error_jobs_signature_sets_count",
        help: "Count of total error-ed signature sets",
      }),
      jobWaitTime: register.histogram({
        name: "lodestar_bls_thread_pool_queue_job_wait_time_seconds",
        help: "Time from job added to the queue to starting the job in seconds",
        buckets: [0.1, 1, 10],
      }),
      queueLength: register.gauge({
        name: "lodestar_bls_thread_pool_queue_length",
        help: "Count of total block processor queue length",
      }),
      totalJobsGroupsStarted: register.gauge({
        name: "lodestar_bls_thread_pool_job_groups_started_total",
        help: "Count of total jobs groups started in bls thread pool, job groups include +1 jobs",
      }),
      totalJobsStarted: register.gauge({
        name: "lodestar_bls_thread_pool_jobs_started_total",
        help: "Count of total jobs started in bls thread pool, jobs include +1 signature sets",
      }),
      totalSigSetsStarted: register.gauge({
        name: "lodestar_bls_thread_pool_sig_sets_started_total",
        help: "Count of total signature sets started in bls thread pool, sig sets include 1 pk, msg, sig",
      }),
      // Re-verifying a batch means doing double work. This number must be very low or it can be a waste of CPU resources
      batchRetries: register.gauge({
        name: "lodestar_bls_thread_pool_batch_retries",
        help: "Count of total batches that failed and had to be verified again.",
      }),
      // To count how many sigs are being validated with the optimization of batching them
      batchSigsSuccess: register.gauge({
        name: "lodestar_bls_thread_pool_batch_sigs_success_total",
        help: "Count of total batches that failed and had to be verified again.",
      }),
      // To measure the time cost of main thread <-> worker message passing
      latencyToWorker: register.histogram({
        name: "lodestar_bls_thread_pool_latency_to_worker",
        help: "Time from sending the job to the worker and the worker receiving it",
        buckets: [0.1],
      }),
      latencyFromWorker: register.histogram({
        name: "lodestar_bls_thread_pool_latency_from_worker",
        help: "Time from the worker sending the result and the main thread receiving it",
        buckets: [0.1],
      }),
    },

    // Sync

    syncChainsStarted: register.gauge<"syncType">({
      name: "lodestar_sync_chains_started",
      help: "Total number of sync chains started events, labeled by syncType",
      labelNames: ["syncType"],
    }),
    syncStatus: register.gauge({
      name: "lodestar_sync_status",
      help: "Range sync status: [Stalled, SyncingFinalized, SyncingHead, Synced]",
    }),

    // Validator monitoring

    validatorMonitor: {
      validatorsTotal: register.gauge({
        name: "validator_monitor_validators_total",
        help: "Count of validators that are specifically monitored by this beacon node",
        labelNames: ["index"],
      }),

      // Validator Monitor Metrics (per-epoch summaries)

      prevEpochOnChainAttesterHit: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_attester_hit",
        help: "Incremented if the validator is flagged as a previous epoch attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainAttesterMiss: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_attester_miss",
        help: "Incremented if the validator is not flagged as a previous epoch attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainHeadAttesterHit: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_head_attester_hit",
        help: "Incremented if the validator is flagged as a previous epoch head attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainHeadAttesterMiss: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_head_attester_miss",
        help:
          "Incremented if the validator is not flagged as a previous epoch head attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainTargetAttesterHit: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_target_attester_hit",
        help: "Incremented if the validator is flagged as a previous epoch target attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainTargetAttesterMiss: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_target_attester_miss",
        help:
          "Incremented if the validator is not flagged as a previous epoch target attester during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochOnChainInclusionDistance: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_on_chain_inclusion_distance",
        help: "The attestation inclusion distance calculated during per epoch processing",
        labelNames: ["index"],
      }),
      prevEpochAttestationsTotal: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_attestations_total",
        help: "The number of unagg. attestations seen in the previous epoch",
        labelNames: ["index"],
      }),
      prevEpochAttestationsMinDelaySeconds: register.histogram<"index">({
        name: "validator_monitor_prev_epoch_attestations_min_delay_seconds",
        help: "The min delay between when the validator should send the attestation and when it was received",
        labelNames: ["index"],
      }),
      prevEpochAttestationAggregateInclusions: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_attestation_aggregate_inclusions",
        help: "The count of times an attestation was seen inside an aggregate",
        labelNames: ["index"],
      }),
      prevEpochAttestationBlockInclusions: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_attestation_block_inclusions",
        help: "The count of times an attestation was seen inside a block",
        labelNames: ["index"],
      }),
      prevEpochAttestationBlockMinInclusionDistance: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_attestation_block_min_inclusion_distance",
        help: "The minimum inclusion distance observed for the inclusion of an attestation in a block",
        labelNames: ["index"],
      }),
      prevEpochBeaconBlocksTotal: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_beacon_blocks_total",
        help: "The number of beacon_blocks seen in the previous epoch",
        labelNames: ["index"],
      }),
      prevEpochBeaconBlocksMinDelaySeconds: register.histogram<"index">({
        name: "validator_monitor_prev_epoch_beacon_blocks_min_delay_seconds",
        help: "The min delay between when the validator should send the block and when it was received",
        labelNames: ["index"],
      }),
      prevEpochAggregatesTotal: register.gauge<"index">({
        name: "validator_monitor_prev_epoch_aggregates_total",
        help: "The number of aggregates seen in the previous epoch",
        labelNames: ["index"],
      }),
      prevEpochAggregatesMinDelaySeconds: register.histogram<"index">({
        name: "validator_monitor_prev_epoch_aggregates_min_delay_seconds",
        help: "The min delay between when the validator should send the aggregate and when it was received",
        labelNames: ["index"],
      }),

      // Validator Monitor Metrics (real-time)

      unaggregatedAttestationTotal: register.gauge<"index" | "src">({
        name: "validator_monitor_unaggregated_attestation_total",
        help: "Number of unaggregated attestations seen",
        labelNames: ["index", "src"],
      }),
      unaggregatedAttestationDelaySeconds: register.histogram<"index" | "src">({
        name: "validator_monitor_unaggregated_attestation_delay_seconds",
        help: "The delay between when the validator should send the attestation and when it was received",
        labelNames: ["index", "src"],
      }),
      aggregatedAttestationTotal: register.gauge<"index" | "src">({
        name: "validator_monitor_aggregated_attestation_total",
        help: "Number of aggregated attestations seen",
        labelNames: ["index", "src"],
      }),
      aggregatedAttestationDelaySeconds: register.histogram<"index" | "src">({
        name: "validator_monitor_aggregated_attestation_delay_seconds",
        help: "The delay between then the validator should send the aggregate and when it was received",
        labelNames: ["index", "src"],
      }),
      attestationInAggregateTotal: register.gauge<"index" | "src">({
        name: "validator_monitor_attestation_in_aggregate_total",
        help: "Number of times an attestation has been seen in an aggregate",
        labelNames: ["index", "src"],
      }),
      attestationInAggregateDelaySeconds: register.histogram<"index" | "src">({
        name: "validator_monitor_attestation_in_aggregate_delay_seconds",
        help: "The delay between when the validator should send the aggregate and when it was received",
        labelNames: ["index", "src"],
      }),
      attestationInBlockTotal: register.gauge<"index">({
        name: "validator_monitor_attestation_in_block_total",
        help: "Number of times an attestation has been seen in a block",
        labelNames: ["index"],
      }),
      attestationInBlockDelaySlots: register.histogram<"index">({
        name: "validator_monitor_attestation_in_block_delay_slots",
        help: "The excess slots (beyond the minimum delay) between the attestation slot and the block slot",
        labelNames: ["index"],
      }),
      beaconBlockTotal: register.gauge<"index" | "src">({
        name: "validator_monitor_beacon_block_total",
        help: "Number of beacon blocks seen",
        labelNames: ["index", "src"],
      }),
      beaconBlockDelaySeconds: register.histogram<"index" | "src">({
        name: "validator_monitor_beacon_block_delay_seconds",
        help: "The delay between when the validator should send the block and when it was received",
        labelNames: ["index", "src"],
      }),
    },
  };
}
