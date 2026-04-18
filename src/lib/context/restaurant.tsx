"use client";

import { createContext, useContext } from "react";

type RestaurantContext = {
  restaurantId: string;
  restaurantName: string;
  userRole: "owner" | "manager" | "staff";
};

const Ctx = createContext<RestaurantContext | null>(null);

export function RestaurantProvider({
  restaurantId,
  restaurantName,
  userRole,
  children,
}: RestaurantContext & { children: React.ReactNode }) {
  return (
    <Ctx value={{ restaurantId, restaurantName, userRole }}>
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
