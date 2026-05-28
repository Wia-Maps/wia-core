export const FELLOWSHIP_BRANDS_UPDATED_EVENT = 'wia:fellowship-brands-updated';

export const publishFellowshipBrandsUpdated = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(FELLOWSHIP_BRANDS_UPDATED_EVENT));
};
