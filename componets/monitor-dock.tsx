import { createRoot } from "react-dom/client";

import BottomNavBar, { ROTAS_NAV_ITEMS, type RotasNavTab } from "@/components/ui/bottom-nav-bar";

const host = document.getElementById("monitorDockReact");

if (host) {
  const element = host;
  const root = createRoot(element);

  function navigate(tab: RotasNavTab) {
    document
      .querySelector<HTMLButtonElement>(`.monitor-dock button[data-view="${tab}"]`)
      ?.click();
  }

  function syncDock() {
    const activeTab = ROTAS_NAV_ITEMS.find(({ id }) => id === element.dataset.view)?.id ?? null;
    root.render(<BottomNavBar activeTab={activeTab} onNavigate={navigate} stickyBottom />);
  }

  new MutationObserver(syncDock).observe(element, {
    attributes: true,
    attributeFilter: ["data-view"],
  });
  syncDock();
}
