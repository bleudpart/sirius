import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { SiriusClient } from "../../shared/client";

export function client() {
  const preferences = getPreferenceValues<{ apiUrl: string; accessToken: string; cerebrasKey?: string }>();
  return new SiriusClient(preferences.apiUrl, preferences.accessToken, preferences.cerebrasKey || "");
}
export const error = (failure: unknown) => showToast({ style: Toast.Style.Failure, title: "SIRIUS",
  message: failure instanceof Error ? failure.message : "Demande interrompue ; consulter la même référence." });
export const literal = (text: string) => text.replace(/[\\`*_[\]<>!#]/g, "\\$&");
