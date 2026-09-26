// Who the deployment belongs to, as agents should call them in prompts and framed messages.
// Set GRIFFIN_OWNER_NAME to a first name ("Sara") so colleagues' messages read naturally.
export const OWNER_NAME = String(process.env.GRIFFIN_OWNER_NAME || "").trim() || "Owner";
