export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  isOfficer: boolean;
  isMember: boolean;
}

export interface GearItem {
  id: number;
  base_item_name: string;
  upgrade_level: string;
  wiki_url: string;
  added_by_user_id: string;
  added_by_username: string;
  requested_by_user_id: string | null;
  requested_by_username: string | null;
  exalts_json: string | null;
  timestamp: string;
}

export type WorkOrderStatus = 'unclaimed' | 'claimed' | 'complete' | 'delivered' | 'cancelled';

export interface WorkOrder {
  id: number;
  item_name: string;
  quantity: number;
  skill_required: string;
  skill_level_required: number | null;
  source_type: string;
  requester_character: string;
  requester_discord_id: string | null;
  requester_discord_name: string | null;
  claimed_by_discord_id: string | null;
  claimed_by_discord_name: string | null;
  status: WorkOrderStatus;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  delivered_at: string | null;
}

export interface GroupedImportItem {
  cleanItemName: string;
  upgradeLevel: string;
  locations: string[];
  totalCount: number;
  sampleItemId: string | null;
  exalts: Record<string, string> | null;
  hasExalts: boolean;
  exaltsSummary: string;
}
