import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Persona = "client" | "finops" | "finance";

interface PersonaState {
  persona: Persona;
  setPersona: (p: Persona) => void;
}

export const usePersona = create<PersonaState>()(
  persist(
    (set) => ({
      persona: "finops",
      setPersona: (p) => set({ persona: p }),
    }),
    { name: "tia.persona" },
  ),
);
