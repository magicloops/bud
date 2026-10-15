export const PERSONAL_DATA_TOOLS = ["contacts_get", "contacts_search", "contacts_history", "location_context", "timeline_query", "health_workouts", "health_sleep"] as const;
export type PersonalDataTool = typeof PERSONAL_DATA_TOOLS[number];
