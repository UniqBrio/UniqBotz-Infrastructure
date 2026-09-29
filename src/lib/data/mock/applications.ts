import type { Application } from "@/lib/domain/types";
import { daysAgo, minutesAgo } from "./clock";

/**
 * Registered applications. Every UniqBotz product is an independent Supabase
 * project; future products are added here (Phase 1) or via the registry API
 * (later phases) and automatically appear across the dashboard.
 */
export const seedApplications: Application[] = [
  {
    id: "rosifit",
    name: "RosiFit",
    description: "Fitness studio operations — attendance, workouts and bookings.",
    supabaseProjectRef: "demo-rosifit-xxxx",
    region: "ap-south-1 (demo)",
    databaseSizeMb: 412,
    databaseCapacityMb: 500,
    connectionStatus: "connected",
    lastHealthCheckAt: minutesAgo(2),
    registeredAt: daysAgo(410),
  },
  {
    id: "uniqbrio",
    name: "UniqBrio",
    description: "Academy management — students, sessions and attendance.",
    supabaseProjectRef: "demo-uniqbrio-xxxx",
    region: "ap-south-1 (demo)",
    databaseSizeMb: 280,
    databaseCapacityMb: 500,
    connectionStatus: "connected",
    lastHealthCheckAt: minutesAgo(3),
    registeredAt: daysAgo(380),
  },
  {
    id: "jalsa",
    name: "Jalsa Restaurant",
    description: "Restaurant operations — orders, items, payments and logs.",
    supabaseProjectRef: "demo-jalsa-xxxx",
    region: "ap-south-1 (demo)",
    databaseSizeMb: 438,
    databaseCapacityMb: 500,
    connectionStatus: "connected",
    lastHealthCheckAt: minutesAgo(1),
    registeredAt: daysAgo(290),
  },
];
