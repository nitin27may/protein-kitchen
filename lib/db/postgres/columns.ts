import { boolean, customType, date, jsonb } from "drizzle-orm/pg-core";

export const json = <T>(name: string) => jsonb(name).$type<T>();
export const bool = (name: string) => boolean(name);
export const isoDate = (name: string) => date(name, { mode: "string" });

// Keep the existing UTC ISO-string contract rather than leaking pg's Date objects or timestamp formatting.
export const isoTimestamp = customType<{ data: string; driverData: string | Date }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => new Date(value).toISOString(),
  toDriver: (value) => value,
});
