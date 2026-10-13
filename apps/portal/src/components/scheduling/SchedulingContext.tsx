'use client';

import { createContext, useContext } from 'react';
import type { SchedulingPeople } from '../../lib/api/scheduling';
import type { ViewMode } from '../../lib/scheduling';

export interface SchedulingContextValue {
  people: SchedulingPeople | null;
  /** Any YYYY-MM-DD inside the visible window. */
  anchor: string;
  setAnchor: (v: string) => void;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  departmentId: string;
  setDepartmentId: (id: string) => void;
}

export const SchedulingContext = createContext<SchedulingContextValue | null>(null);

export function useScheduling(): SchedulingContextValue {
  const v = useContext(SchedulingContext);
  if (!v) throw new Error('useScheduling must be used inside the /scheduling layout');
  return v;
}
