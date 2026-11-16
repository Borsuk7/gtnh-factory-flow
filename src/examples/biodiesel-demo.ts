import biodieselDemoJson from "../../fixtures/biodiesel-demo.json";
import { factoryProjectSchema } from "@/lib/model/schemas";
import type { FactoryProject } from "@/lib/model/types";

export function loadBiodieselDemoProject(): FactoryProject {
  return factoryProjectSchema.parse(biodieselDemoJson);
}
