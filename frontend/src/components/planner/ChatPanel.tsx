"use client";

import { useState, type FormEvent } from "react";
import type { ChatMessage } from "@/lib/types";
import { SUGGESTION_CHIPS } from "@/lib/constants";
import { MessageBubble } from "./MessageBubble";
import { SuggestionChips } from "./SuggestionChips";

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (message: string) => void;
}

export function ChatPanel({ messages, isLoading, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-400">
              입력 중...
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-slate-100 px-5 py-4">
        <div className="mb-3">
          <SuggestionChips
            suggestions={SUGGESTION_CHIPS}
            onSelect={onSend}
            disabled={isLoading}
          />
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="여행 취향을 말씀해주세요"
            disabled={isLoading}
            className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-brand disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            보내기
          </button>
        </form>
      </div>
    </div>
  );
}
