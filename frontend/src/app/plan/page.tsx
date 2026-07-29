"use client";

import { useState } from "react";
import { ChatPanel } from "@/components/planner/ChatPanel";
import { ItineraryEmptyState } from "@/components/planner/ItineraryEmptyState";
import { ItineraryPanel } from "@/components/planner/ItineraryPanel";
import { Button } from "@/components/ui/Button";
import { sendMessage } from "@/lib/api/itinerary";
import { hasItinerary, resolveMobileTab, type MobileTab } from "@/lib/plan-view";
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
  const [activeMobileTab, setActiveMobileTab] = useState<MobileTab>("chat");
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  async function handleSend(content: string) {
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
      setActiveMobileTab(resolveMobileTab(result.planStatus));
      if (result.planStatus === "ready") {
        setIsPanelOpen(true);
      }
    } catch (error) {
      // 실패한 사용자 메시지는 목록에 그대로 둔다 — 되돌리면 사용자가 무엇을
      // 보냈는지 사라진다. 안내는 말풍선으로 덧붙이고 입력창은 finally에서
      // 다시 열리므로 그대로 다시 보낼 수 있다.
      const errorMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content:
          error instanceof Error
            ? error.message
            : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }

  const itineraryExists = hasItinerary(itinerary);
  const showPanel = isPanelOpen;
  const showMobileTabBar = itineraryExists && showPanel;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        {showMobileTabBar && (
          <div className="flex flex-1 gap-2 md:hidden">
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
        )}
        <Button
          type="button"
          variant="ghost"
          size="md"
          onClick={() => setIsPanelOpen((prev) => !prev)}
        >
          {showPanel ? "일정 패널 닫기" : "일정 패널 열기"}
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={`w-full flex-col md:flex ${
            showPanel ? "border-r border-slate-100 md:w-[40%]" : "md:w-full"
          } ${!showMobileTabBar || activeMobileTab === "chat" ? "flex" : "hidden"}`}
        >
          <ChatPanel messages={messages} isLoading={isLoading} onSend={handleSend} />
        </div>
        {showPanel && (
          <div
            className={`w-full flex-col md:flex md:w-[60%] ${
              showMobileTabBar && activeMobileTab === "itinerary" ? "flex" : "hidden"
            }`}
          >
            {itineraryExists ? (
              <ItineraryPanel itinerary={itinerary} />
            ) : (
              <ItineraryEmptyState />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
