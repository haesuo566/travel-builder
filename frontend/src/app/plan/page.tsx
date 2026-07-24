"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/planner/ChatPanel";
import { ItineraryPanel } from "@/components/planner/ItineraryPanel";
import { getItinerary, sendMessage } from "@/lib/api/itinerary";
import type { ChatMessage, Itinerary } from "@/lib/types";

const INITIAL_ASSISTANT_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "안녕하세요! 여로예요. 어디로, 며칠 일정으로 떠나고 싶으신가요? '제주 2박3일'처럼 말씀해주셔도 좋아요.",
};

function createMessageId(): string {
  return crypto.randomUUID();
}

export default function PlanPage() {
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    INITIAL_ASSISTANT_MESSAGE,
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeMobileTab, setActiveMobileTab] = useState<"chat" | "itinerary">(
    "chat"
  );

  useEffect(() => {
    getItinerary().then(setItinerary);
  }, []);

  async function handleSend(content: string) {
    if (!itinerary) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const result = await sendMessage(content, itinerary);

      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: result.reply,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setItinerary(result.itinerary);
      setActiveMobileTab("itinerary");
    } finally {
      setIsLoading(false);
    }
  }

  if (!itinerary) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        불러오는 중...
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex gap-2 border-b border-slate-100 px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={() => setActiveMobileTab("chat")}
          className={`flex-1 rounded-xl py-2 text-sm font-medium ${
            activeMobileTab === "chat"
              ? "bg-brand text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          채팅
        </button>
        <button
          type="button"
          onClick={() => setActiveMobileTab("itinerary")}
          className={`flex-1 rounded-xl py-2 text-sm font-medium ${
            activeMobileTab === "itinerary"
              ? "bg-brand text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          일정
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={`w-full flex-col border-r border-slate-100 md:flex md:w-[40%] ${
            activeMobileTab === "chat" ? "flex" : "hidden"
          }`}
        >
          <ChatPanel messages={messages} isLoading={isLoading} onSend={handleSend} />
        </div>
        <div
          className={`w-full flex-col md:flex md:w-[60%] ${
            activeMobileTab === "itinerary" ? "flex" : "hidden"
          }`}
        >
          <ItineraryPanel itinerary={itinerary} />
        </div>
      </div>
    </div>
  );
}
