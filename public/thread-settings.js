const permissionModeDefinitions = [
  {
    id: "read-only",
    labelKey: "permission.readOnly",
    descriptionKey: "permission.readOnlyDescription",
    permissions: ":read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  },
  {
    id: "request-approval",
    labelKey: "permission.requestApproval",
    descriptionKey: "permission.requestApprovalDescription",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  },
  {
    id: "agent-review",
    labelKey: "permission.agentReview",
    descriptionKey: "permission.agentReviewDescription",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent"
  },
  {
    id: "full-access",
    labelKey: "permission.fullAccess",
    descriptionKey: "permission.fullAccessDescription",
    permissions: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user"
  }
];

export function availablePermissionModes(profiles = [], requirements = null) {
  const allowedProfiles = new Set(
    (profiles || [])
      .filter((profile) => profile?.allowed !== false)
      .map((profile) => profile?.id)
      .filter(Boolean)
  );
  const allowedPolicies = normalizedRequirementValues(requirements?.allowedApprovalPolicies);
  const allowedReviewers = normalizedRequirementValues(requirements?.allowedApprovalsReviewers);

  const builtIns = permissionModeDefinitions.filter((mode) => {
    if (!allowedProfiles.has(mode.permissions)) return false;
    if (allowedPolicies && !allowedPolicies.has(normalizeRequirementValue(mode.approvalPolicy))) return false;
    if (allowedReviewers && !allowedReviewers.has(normalizeRequirementValue(mode.approvalsReviewer))) return false;
    return true;
  });
  const builtInProfiles = new Set(permissionModeDefinitions.map((mode) => mode.permissions));
  const customProfiles = (profiles || [])
    .filter((profile) => profile?.allowed !== false && profile?.id && !builtInProfiles.has(profile.id))
    .map((profile) => ({
      id: `profile:${profile.id}`,
      label: profile.description || profile.id,
      description: profile.description || profile.id,
      permissions: profile.id,
      approvalPolicy: "on-request",
      approvalsReviewer: "user"
    }))
    .filter((mode) => (
      (!allowedPolicies || allowedPolicies.has(normalizeRequirementValue(mode.approvalPolicy)))
      && (!allowedReviewers || allowedReviewers.has(normalizeRequirementValue(mode.approvalsReviewer)))
    ));
  return [...builtIns, ...customProfiles];
}

export function permissionModeById(modeId, modes = permissionModeDefinitions) {
  return (modes || []).find((mode) => mode.id === modeId) || null;
}

export function permissionModeFromSettings(settings, modes = permissionModeDefinitions) {
  if (!settings) return "";
  const profileId = settings.activePermissionProfile?.id
    || settings.permissions
    || permissionProfileFromSandbox(settings.sandboxPolicy);
  const approvalPolicy = settings.approvalPolicy || "";
  const approvalsReviewer = settings.approvalsReviewer || "user";
  return (modes || []).find((mode) => (
    mode.permissions === profileId
    && mode.approvalPolicy === approvalPolicy
    && mode.approvalsReviewer === approvalsReviewer
  ))?.id || "custom";
}

export function threadSettingsFromResume(result) {
  if (!result) return null;
  return normalizeThreadSettings({
    cwd: result.cwd || result.thread?.cwd,
    model: result.model,
    effort: result.reasoningEffort ?? result.effort,
    serviceTier: result.serviceTier,
    approvalPolicy: result.approvalPolicy,
    approvalsReviewer: result.approvalsReviewer,
    activePermissionProfile: result.activePermissionProfile,
    sandboxPolicy: result.sandbox || result.sandboxPolicy
  });
}

export function threadSettingsFromNotification(params) {
  if (!params?.threadSettings) return null;
  return normalizeThreadSettings(params.threadSettings);
}

export function buildThreadSettingsUpdate({ threadId, model, effort, permissionMode, modes }) {
  if (!threadId) throw new Error("threadId is required");
  return {
    threadId,
    ...runtimeSelectionParams({ model, effort, permissionMode, modes })
  };
}

export function buildSharedThreadStart({ cwd, model, effort, permissionMode, modes }) {
  if (!cwd) throw new Error("cwd is required");
  return {
    cwd,
    ...runtimeSelectionParams({ model, effort, permissionMode, modes })
  };
}

function runtimeSelectionParams({ model, effort, permissionMode, modes }) {
  const mode = permissionModeById(permissionMode, modes);
  if (!mode) throw new Error(`Unsupported permission mode: ${permissionMode}`);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    permissions: mode.permissions,
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: mode.approvalsReviewer
  };
}

function normalizeThreadSettings(settings) {
  return {
    cwd: settings?.cwd || "",
    model: settings?.model || "",
    effort: settings?.effort ?? settings?.reasoningEffort ?? "",
    serviceTier: settings?.serviceTier ?? null,
    approvalPolicy: settings?.approvalPolicy || "",
    approvalsReviewer: settings?.approvalsReviewer || "user",
    activePermissionProfile: settings?.activePermissionProfile || null,
    sandboxPolicy: settings?.sandboxPolicy || settings?.sandbox || null
  };
}

function normalizedRequirementValues(values) {
  if (!Array.isArray(values)) return null;
  return new Set(values.map(normalizeRequirementValue));
}

function normalizeRequirementValue(value) {
  return String(value || "")
    .replace(/_/g, "-")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function permissionProfileFromSandbox(sandboxPolicy) {
  const type = sandboxPolicy?.type || sandboxPolicy || "";
  if (type === "dangerFullAccess" || type === "danger-full-access") return ":danger-full-access";
  if (type === "readOnly" || type === "read-only") return ":read-only";
  if (type === "workspaceWrite" || type === "workspace-write") return ":workspace";
  return "";
}
