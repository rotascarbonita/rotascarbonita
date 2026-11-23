"use client";

import { useId, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChartNoAxesColumn, House, UserRound, UsersRound } from "lucide-react";

import { cn } from "@/lib/utils";

export const ROTAS_NAV_ITEMS = [
  { id: "dashboard", label: "Visão geral", icon: House },
  { id: "students", label: "Estudantes", icon: UsersRound },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesColumn },
  { id: "profile", label: "Perfil", icon: UserRound },
] as const;

export type RotasNavTab = (typeof ROTAS_NAV_ITEMS)[number]["id"];

type BottomNavBarProps = {
  className?: string;
  activeTab?: RotasNavTab | null;
  defaultIndex?: number;
  stickyBottom?: boolean;
  onNavigate?: (tab: RotasNavTab) => void;
};

export function BottomNavBar({
  className,
  activeTab,
  defaultIndex = 0,
  stickyBottom = false,
  onNavigate,
}: BottomNavBarProps) {
  const [selected, setSelected] = useState(
    () => ROTAS_NAV_ITEMS[defaultIndex]?.id ?? ROTAS_NAV_ITEMS[0].id,
  );
  const pillId = useId();
  const reducedMotion = useReducedMotion();

  return (
    <nav
      aria-label="Navegação da monitora"
      className={cn(
        "rotas-bottom-nav grid w-full max-w-[30rem] grid-cols-4 gap-0.5 rounded-[1.5rem] border border-[var(--line)] p-1.5",
        "bg-[var(--surface)] text-[var(--text)] shadow-[0_8px_28px_#071d4126]",
        stickyBottom && "rotas-bottom-nav--fixed",
        className,
      )}
    >
      {ROTAS_NAV_ITEMS.map(({ id, label, icon: Icon }) => {
        const isActive = (activeTab === undefined ? selected : activeTab) === id;

        return (
          <motion.button
            key={id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            whileTap={reducedMotion ? undefined : { scale: 0.96 }}
            onClick={() => {
              if (activeTab === undefined) setSelected(id);
              onNavigate?.(id);
            }}
            className={cn(
              "relative isolate flex min-h-13 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[1.125rem] px-0.5 py-1",
              "border-0 bg-transparent text-center text-[0.6875rem] leading-tight font-semibold text-inherit",
              "hover:bg-[var(--tint)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]",
              isActive && "text-[var(--blue)]",
            )}
          >
            {isActive && (
              <motion.span
                aria-hidden="true"
                layoutId={reducedMotion ? undefined : pillId}
                transition={{ type: "spring", stiffness: 390, damping: 33 }}
                className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[var(--tint)]"
              />
            )}
            <Icon aria-hidden="true" size={21} strokeWidth={isActive ? 2.25 : 1.8} />
            <span className="max-w-full [overflow-wrap:anywhere]">{label}</span>
          </motion.button>
        );
      })}
    </nav>
  );
}

export default BottomNavBar;
