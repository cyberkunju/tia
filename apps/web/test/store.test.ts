import { beforeEach, describe, expect, it } from "vitest";
import { usePersona } from "../src/store";
import type { FocusedEntity } from "../src/types";

// The store is a persisted singleton. localStorage is cleared by the global
// afterEach (test/setup.ts); here we also reset the in-memory state to the
// coded defaults before each test so ordering never matters.
beforeEach(() => {
  usePersona.setState({
    persona: "client",
    currentClientCode: "CL001",
    resetTick: 0,
    aidaOpen: false,
    focusedEntity: null,
  });
});

describe("usePersona defaults", () => {
  it("starts as the client persona pinned to CL001", () => {
    const s = usePersona.getState();
    expect(s.persona).toBe("client");
    expect(s.currentClientCode).toBe("CL001");
    expect(s.resetTick).toBe(0);
    expect(s.aidaOpen).toBe(false);
    expect(s.focusedEntity).toBeNull();
  });
});

describe("setPersona", () => {
  it("switches to finops/finance without touching the client code", () => {
    usePersona.getState().setPersona("finops");
    expect(usePersona.getState().persona).toBe("finops");
    expect(usePersona.getState().currentClientCode).toBe("CL001");

    usePersona.getState().setPersona("finance");
    expect(usePersona.getState().persona).toBe("finance");
  });

  it("auto-picks CL001 when switching to client with no client code set", () => {
    usePersona.setState({ persona: "finops", currentClientCode: null });
    usePersona.getState().setPersona("client");
    expect(usePersona.getState().persona).toBe("client");
    expect(usePersona.getState().currentClientCode).toBe("CL001");
  });

  it("keeps an already-chosen client code when re-entering the client persona", () => {
    usePersona.setState({ persona: "finops", currentClientCode: "CL009" });
    usePersona.getState().setPersona("client");
    expect(usePersona.getState().currentClientCode).toBe("CL009");
  });

  it("does not auto-assign a client code when switching to a non-client persona", () => {
    usePersona.setState({ persona: "client", currentClientCode: null });
    usePersona.getState().setPersona("finops");
    expect(usePersona.getState().currentClientCode).toBeNull();
  });
});

describe("setCurrentClientCode", () => {
  it("sets and clears the current client code", () => {
    usePersona.getState().setCurrentClientCode("CL002");
    expect(usePersona.getState().currentClientCode).toBe("CL002");

    usePersona.getState().setCurrentClientCode(null);
    expect(usePersona.getState().currentClientCode).toBeNull();
  });
});

describe("bumpReset", () => {
  it("monotonically increments resetTick", () => {
    expect(usePersona.getState().resetTick).toBe(0);
    usePersona.getState().bumpReset();
    expect(usePersona.getState().resetTick).toBe(1);
    usePersona.getState().bumpReset();
    expect(usePersona.getState().resetTick).toBe(2);
  });
});

describe("setAidaOpen", () => {
  it("toggles the AIDA panel open flag", () => {
    usePersona.getState().setAidaOpen(true);
    expect(usePersona.getState().aidaOpen).toBe(true);
    usePersona.getState().setAidaOpen(false);
    expect(usePersona.getState().aidaOpen).toBe(false);
  });
});

describe("setFocusedEntity", () => {
  it("sets and clears the focused entity", () => {
    const entity: FocusedEntity = { kind: "invoice", id: "INV-1", ref: "INV-0001" };
    usePersona.getState().setFocusedEntity(entity);
    expect(usePersona.getState().focusedEntity).toEqual(entity);

    usePersona.getState().setFocusedEntity(null);
    expect(usePersona.getState().focusedEntity).toBeNull();
  });
});

describe("persistence (partialize)", () => {
  it("persists only persona + currentClientCode, never per-session UI state", () => {
    usePersona.getState().setPersona("finance");
    usePersona.getState().setCurrentClientCode("CL003");
    usePersona.getState().setAidaOpen(true);
    usePersona.getState().bumpReset();
    usePersona.getState().setFocusedEntity({ kind: "document", id: "D1" });

    const raw = window.localStorage.getItem("tia.persona.v2");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string);

    expect(persisted.state).toEqual({ persona: "finance", currentClientCode: "CL003" });
    // per-session fields must NOT be written to storage
    expect(persisted.state).not.toHaveProperty("aidaOpen");
    expect(persisted.state).not.toHaveProperty("resetTick");
    expect(persisted.state).not.toHaveProperty("focusedEntity");
  });
});
