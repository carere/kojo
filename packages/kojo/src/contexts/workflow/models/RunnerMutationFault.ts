export interface RunnerMutationFault {
  readonly kind:
    | "BeginResourceAcquisition"
    | "ConfirmResourceAcquired"
    | "BeginResourceRelease"
    | "ConfirmResourceReleased"
    | "PreserveResource"
    | "ReportRecovery";
  readonly runId: string;
  readonly leaseId: string;
}
