import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className = "", ...rest }: CardProps) {
  return (
    <div
      className={`rounded-2xl bg-white shadow-sm shadow-slate-200/60 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
