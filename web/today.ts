import { api } from './api';
import { useApp } from './context';

/** Sections you took off the Today column, and a way to take one off or bring them all back. */
export function useToday() {
  const { settings, toast } = useApp();
  const hidden = settings?.today?.hidden ?? [];
  const save = async (next: string[]) => {
    try {
      await api('/settings', { method: 'PUT', body: { today: { hidden: next } } });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return {
    hidden,
    isHidden: (id: string) => hidden.includes(id),
    hide: (id: string, title: string) => {
      void save([...new Set([...hidden, id])]);
      toast(`${title} is off Today. “Show hidden” at the bottom brings it back.`);
    },
    showAll: () => void save([]),
  };
}
