import type { PowerSignal } from '../store/useAppStore';

export const POWER_SUPPLY_FILTER = 'Power supply';

export const isPowerSupplyFilter = (category: string): boolean => category === POWER_SUPPLY_FILTER;

export const hasPowerSupply = (
  locationId: string,
  powerSignalMap: Map<string, PowerSignal>
): boolean => powerSignalMap.get(locationId)?.powerStatus === true;

export const matchesLocationFilters = (
  category: string,
  activeFilters: string[]
): boolean => {
  const categoryFilters = activeFilters.filter((filter) => !isPowerSupplyFilter(filter));

  if (categoryFilters.length === 0) {
    return true;
  }

  return categoryFilters.includes(category);
};
