export const PERSONAL_DATA_TOOLS = ["contacts_search", "contacts_history", "location_context", "timeline_query"] as const;
export type PersonalDataTool = typeof PERSONAL_DATA_TOOLS[number];
