import { Suspense } from 'react';
import { Spinner } from '@librechat/client';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel } from '~/Providers';
import { useLocalize } from '~/hooks';

/** Panels load on first open; on a slow link the fetch would otherwise leave the panel blank. */
function PanelLoading() {
  const localize = useLocalize();
  return (
    <div role="status" className="text-text-secondary flex flex-1 items-center justify-center py-8">
      <Spinner size={20} />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
  );
}

export default function Nav({ links }: { links: NavLink[] }) {
  const { active } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  return (
    <div className="text-text-primary flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      <Suspense fallback={<PanelLoading />}>
        {links.map((link) =>
          link.id === effectiveActive && link.Component ? <link.Component key={link.id} /> : null,
        )}
      </Suspense>
    </div>
  );
}
