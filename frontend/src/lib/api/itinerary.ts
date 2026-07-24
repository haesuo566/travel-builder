import type { Itinerary } from "../types";
import { getDefaultItinerary } from "../mock/itineraries";
import { generateAssistantReply, type ScenarioResult } from "../mock/scenarios";

export async function getItinerary(): Promise<Itinerary> {
  return getDefaultItinerary();
}

export async function sendMessage(
  message: string,
  currentItinerary: Itinerary
): Promise<ScenarioResult> {
  return generateAssistantReply(message, currentItinerary);
}
