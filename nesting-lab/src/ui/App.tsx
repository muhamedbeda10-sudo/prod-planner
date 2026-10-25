import { useCallback, useMemo, useRef, useState } from "react";
import { analyzeDxf } from "../engine/dxf/analyze";
import { suggestFromFileName } from "../engine/dxf/fileName";
import { DEFAULT_STRATEGIES, validateSettings } from "../engine/nesting/nest";
import type { MachinesFile } from "../engine/machines/types";
import machinesJson from "../../config/machines.local.json";
import materialsJson from "../../config/materials.local.json";
import { buildParts, IDLE_RUN, toSettings, type LoadedFile, type PartRow, type RunState, type SettingsForm } from "./state";
import { FilesPanel } from "./FilesPanel";
import { SettingsPanel } from "./SettingsPanel";
import { ResultsPanel } from "./ResultsPanel";
import { MachinesPanel } from "./MachinesPanel";
import { ExportPanel } from "./ExportPanel";

const TABS = ["Files & parts", "Settings", "Nest & review", "Machines", "Export"] as const;

const materials = materialsJson as { materials: { name: string; densityKgM3: number }[]; sheetSizes: { label: string; widthMm: number; heightMm: number }[]; thicknessesMm: number[] };

const DEFAULT_FORM: SettingsForm = {
  sheetPreset: "1220*2440",
  widthMm: 1220,
  heightMm: 2440,
  unlimited: true,
  quantity: 10,
  material: "Steel",
  thicknessMm: 5,
  spacingMm: 5,
  marginMm: 5,
  rotations: [0, 90, 180, 270],
  allowMirror: false,
  noGoZones: [],
  strategies: DEFAULT_STRATEGIES,
  timeBudgetS: 30,
  sagittaMm: 0.3,
  simplifyTolMm: 0.05,
};

let fileSeq = 0;

function analyze(f: LoadedFile): LoadedFile {
  try {
    const analysis = analyzeDxf(f.name, f.bytes, { unit: f.unit, layerRoles: f.layerRoles, thicknessMm: f.thicknessMm });
    return { ...f, analysis, error: null };
  } catch (err) {
    return { ...f, analysis: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function App() {
  const [tab, setTab] = useState(0);
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [rows, setRows] = useState<Record<string, PartRow>>({});
  const [form, setForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [machines, setMachines] = useState<MachinesFile>(machinesJson as unknown as MachinesFile);
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const workerRef = useRef<Worker | null>(null);

  // the first detected sheet boundary / thickness become the form's defaults
  // (only while the form is still untouched)
  const adoptDefaults = (fs: LoadedFile[]) => {
    const first = fs.find((f) => f.analysis?.classification?.sheetSize);
    const size = first?.analysis?.classification?.sheetSize;
    if (!size) return;
    setForm((cur) => (cur === DEFAULT_FORM ? { ...DEFAULT_FORM, sheetPreset: "custom", widthMm: size.w, heightMm: size.h, thicknessMm: first?.thicknessMm ?? DEFAULT_FORM.thicknessMm } : cur));
  };

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const loaded: LoadedFile[] = [];
    for (const file of Array.from(list)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hints = suggestFromFileName(file.name);
      loaded.push(analyze({ id: `f${++fileSeq}`, name: file.name, bytes, unit: null, layerRoles: {}, thicknessMm: null, bom: "", hints, analysis: null, error: null }));
    }
    setFiles((prev) => [...prev, ...loaded]);
    adoptDefaults(loaded);
  }, []);

  const updateFile = useCallback(
    (id: string, patch: Partial<Pick<LoadedFile, "unit" | "layerRoles" | "thicknessMm" | "bom">>) => {
      // only the unit, the layer roles and the thickness enter the analysis; a BOM label does not
      const reanalyze = "unit" in patch || "layerRoles" in patch || "thicknessMm" in patch;
      const next = files.map((f) => (f.id === id ? (reanalyze ? analyze({ ...f, ...patch }) : { ...f, ...patch }) : f));
      setFiles(next);
      if (reanalyze) adoptDefaults(next);
    },
    [files],
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setRows((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${id}:`))));
  }, []);

  const built = useMemo(() => buildParts(files, rows), [files, rows]);
  const settings = useMemo(() => toSettings(form), [form]);
  const settingsErrors = useMemo(() => validateSettings(settings, built.parts), [settings, built.parts]);

  const startNest = useCallback(() => {
    if (settingsErrors.length > 0) return;
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./nest.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const parts = built.parts;
    setRun({ ...IDLE_RUN, status: "running", startedAt: performance.now(), parts });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "progress") setRun((r) => ({ ...r, progress: msg.progress }));
      else if (msg.type === "done") {
        setRun((r) => ({ ...r, status: "done", result: msg.result, verification: msg.verification }));
        worker.terminate();
      } else if (msg.type === "error") {
        setRun((r) => ({ ...r, status: "error", error: msg.message }));
        worker.terminate();
      }
    };
    worker.onerror = (e) => setRun((r) => ({ ...r, status: "error", error: e.message }));
    worker.postMessage({ parts, settings });
    setTab(2);
  }, [built.parts, settings, settingsErrors]);

  const cancelNest = useCallback(() => {
    workerRef.current?.terminate();
    setRun((r) => ({ ...r, status: r.result ? "done" : "idle", error: null }));
  }, []);

  const totalParts = built.parts.reduce((n, p) => n + p.quantity, 0);

  return (
    <div className="app">
      <div className="top">
        <h1>Nesting Lab</h1>
        <span className="sub">Local prototype — DXF analysis, true-shape nesting, machine fit, export. Nothing here touches the planner&apos;s database.</span>
      </div>
      <nav className="tabs" aria-label="Steps">
        {TABS.map((t, i) => (
          <button key={t} className={i === tab ? "active" : ""} onClick={() => setTab(i)} aria-current={i === tab ? "step" : undefined}>
            <span className="n">{i + 1}</span>
            {t}
            {i === 0 && files.length > 0 && <span className="badge muted" style={{ marginLeft: 6 }}>{files.length} file{files.length > 1 ? "s" : ""} · {totalParts} parts</span>}
            {i === 2 && run.status === "running" && <span className="spin" style={{ marginLeft: 6 }} aria-hidden="true" />}
          </button>
        ))}
      </nav>
      {tab === 0 && <FilesPanel files={files} rows={rows} onAdd={addFiles} onUpdate={updateFile} onRemove={removeFile} onRows={setRows} onNext={() => setTab(1)} />}
      {tab === 1 && <SettingsPanel form={form} onChange={setForm} materials={materials} parts={built.parts} skipped={built.skipped} errors={settingsErrors} onRun={startNest} running={run.status === "running"} />}
      {tab === 2 && <ResultsPanel run={run} onCancel={cancelNest} onRerun={startNest} canRun={settingsErrors.length === 0} />}
      {tab === 3 && <MachinesPanel machines={machines} onChange={setMachines} settings={settings} result={run.result} />}
      {tab === 4 && <ExportPanel run={run} machines={machines} />}
    </div>
  );
}
