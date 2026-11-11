import type { ModeSettings, TierChampion } from "./types";
import type { RankingSave } from "./rankingSaves";
import { defaultModeSettings } from "./modeSettings";
import { createDefaultRoster } from "./tiers";

/** State shared by several feature areas. Feature-private state stays in its own module. */
export const state: {
  /** Shared ARAM + Mayhem mode settings; mirrors the 模式 settings form. */
  currentSettings: ModeSettings;
  /** Champion roster with tier, flag and secondary spell; this is the working ranking. */
  profileList: TierChampion[];
  /** Every named 排序存檔; each one stores its own last manual save in `items`. */
  rankingSaves: RankingSave[];
  /** Id of the save the bar currently treats as active. */
  activeRankingSave: string;
  /** Whether the LCU client is connected; drives the connection pill and phase labels. */
  isLcuConnected: boolean;
  /** Last gameflow phase seen, compared against the new one to detect a change. */
  lastKnownPhase: string;
} = {
  currentSettings: defaultModeSettings(),
  profileList: createDefaultRoster(),
  rankingSaves: [],
  activeRankingSave: "",
  isLcuConnected: false,
  lastKnownPhase: "",
};
