import { fetchAndActivate, getValue } from "firebase/remote-config";
import { firebase } from "../firebase.js";
import template from "../../../../firebase/remoteconfig.template.json";

/**
 * Model names for the console's cloud calls come from Remote Config (ADR 0001), with the
 * template's defaults bundled so the console works before the first fetch.
 */
type Key = "tandem_judge_model" | "tandem_repair_model" | "tandem_reference_model";
const defaults = Object.fromEntries(
  Object.entries(template.parameters).map(([k, v]) => [k, v.defaultValue.value]),
) as Record<Key, string>;
const live: Partial<Record<Key, string>> = {};

export async function loadModelConfig(): Promise<void> {
  const rc = firebase().remoteConfig;
  if (!rc) return;
  rc.defaultConfig = defaults;
  await fetchAndActivate(rc).catch(() => undefined);
  for (const k of Object.keys(defaults) as Key[]) live[k] = getValue(rc, k).asString() || defaults[k];
}

const get = (k: Key) => live[k] ?? defaults[k];
export const judgeModel = () => get("tandem_judge_model");
export const repairModel = () => get("tandem_repair_model");
export const referenceModel = () => get("tandem_reference_model");
