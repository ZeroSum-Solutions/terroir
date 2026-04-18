"use client";

import { createContext, useContext } from "react";

type RestaurantContext = {
  restaurantId: string;
  restaurantName: string;
};

const Ctx = createContext<RestaurantContext | null>(null);

export function RestaurantProvider({
  restaurantId,
  restaurantName,
  children,
}: RestaurantContext & { children: React.ReactNode }) {
  return (
    <Ctx value={{ restaurantId, restaurantName }}>
      {children}
    </Ctx>
  );
}

export function useRestaurant(): RestaurantContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useRestaurant must be used within RestaurantProvider");
  }
  return ctx;
}
