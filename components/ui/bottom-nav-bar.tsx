"use client";

import { useState } from "react";
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

  return (
    <nav
      aria-label="Navegação da monitora"
      className={cn(
        "rotas-bottom-nav dock-tabs",
        stickyBottom && "rotas-bottom-nav--fixed",
        className,
      )}
    >
      <span className="dock-tabs-indicator" aria-hidden="true" />
      {ROTAS_NAV_ITEMS.map(({ id, label, icon: Icon }) => {
        const isActive = (activeTab === undefined ? selected : activeTab) === id;

        return (
          <button
            key={id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (activeTab === undefined) setSelected(id);
              onNavigate?.(id);
            }}
          >
            <Icon aria-hidden="true" size={21} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default BottomNavBar;
