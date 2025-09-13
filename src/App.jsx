import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Upload, Plus, Pencil, Users, Settings, Move3D, Link as LinkIcon, SlidersHorizontal, LayoutTemplate } from "lucide-react";

/**
 * Academic Monitoring — Seating Chart (Refined + Free Layout + Safer Migration)
 *
 * What’s included
 * - Grid seating with tap-to-cycle levels per skill
 * - Move Seats mode (swap in grid)
 * - NEW: Free Layout mode (drag desks anywhere; touch + mouse)
 * - Global Skill Library: one skill can be linked to multiple classes
 * - Skill metadata: Domain (NC categories) + Standard Code WITHOUT the NC.7 prefix (e.g., RP.2, EE.3)
 * - Robust import/migration with validation and guardrails
 * - Export/Import JSON
 *
 * Levels (0-4)
 *   0 = N/A, 1 = Help, 2 = Developing, 3 = Proficient, 4 = Advanced
 *
 * Notes
 * - This file is plain React (no TypeScript types) to reduce build friction.
 * - We added lightweight runtime tests for the migration function at the bottom (console.assert).
 */

// ---------- Utilities ----------
const lsKey = "seating-monitor-v3"; // bumped: v3 adds free layout + safer migration
const uid = () => Math.random().toString(36).slice(2, 9);

// NC domains for quick tagging (editable list)
const NC_DOMAINS = [
  "Number System",
  "Ratios & Proportions",
  "Expressions & Equations",
  "Geometry",
  "Statistics & Probability",
];

// ---------- Data Shapes (informal JSDoc) ----------
/** @typedef {{ id: string, name: string }} Student */
/** @typedef {{ r: number, c: number, studentId: string | null, x?: number, y?: number }} Seat */  // x,y are 0..1 for free layout
/** @typedef {{ id: string, name: string, domain?: string, standardCode?: string, classIds: string[] }} Skill */
/** @typedef {{ id: string, name: string, rows: number, cols: number, seats: Seat[], students: Student[], marks: Record<string, Record<string, number>>, layoutMode?: 'grid'|'free' }} ClassData */
/** @typedef {{ classes: ClassData[], skills: Skill[], selectedClassId: string, selectedSkillId: string|null }} AppState */

// ---------- Defaults ----------
const DEFAULT_STATE = () => {
  const classId = uid();
  const s1 = uid();
  const s2 = uid();
  const rows = 4, cols = 6;
  const students = Array.from({ length: 24 }, (_, i) => ({ id: uid(), name: `Student ${i + 1}` }));
  const seats = Array.from({ length: rows * cols }, (_, i) => ({ r: Math.floor(i / cols), c: i % cols, studentId: students[i]?.id ?? null }));
  const skills = [
    { id: s1, name: "Distributive Property — Basic", domain: "Expressions & Equations", standardCode: "EE.*", classIds: [classId] },
    { id: s2, name: "Distribute with Negative Numbers", domain: "Expressions & Equations", standardCode: "EE.*", classIds: [classId] },
  ];
  const marks = { [s1]: {}, [s2]: {} };
  /** @type {AppState} */
  const state = {
    classes: [{ id: classId, name: "Period 1", rows, cols, seats, students, marks, layoutMode: "grid" }],
    skills,
    selectedClassId: classId,
    selectedSkillId: s1,
  };
  return state;
};

// ---------- Persistence + Safer Migration ----------
function cleanStandard(code) {
  if (typeof code !== "string") return code;
  // Strip leading "NC.7." if present, but leave other text alone
  return code.replace(/^NC\.7\./, "");
}

function migrateLegacy(raw) {
  // Accepts raw JSON string; returns a valid AppState
  try {
    const parsed = JSON.parse(raw);
    const st = (parsed && typeof parsed === "object") ? parsed : DEFAULT_STATE();

    // Ensure classes array
    if (!Array.isArray(st.classes)) st.classes = DEFAULT_STATE().classes;

    // If st.skills already an array of objects, lightly sanitize
    if (Array.isArray(st.skills)) {
      st.skills = st.skills
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          id: typeof s.id === "string" ? s.id : uid(),
          name: typeof s.name === "string" ? s.name : "(unnamed skill)",
          domain: typeof s.domain === "string" ? s.domain : undefined,
          standardCode: cleanStandard(s.standardCode),
          classIds: Array.isArray(s.classIds) ? s.classIds.filter(Boolean) : [],
        }));
    } else {
      // Legacy shape: skills lived under each class; lift them into a global library
      /** @type {Skill[]} */
      const lifted = [];
      const seen = new Map(); // key -> id
      st.classes.forEach((cl) => {
        const clSkills = Array.isArray(cl.skills) ? cl.skills : [];
        clSkills.forEach((sk) => {
          if (!sk || typeof sk !== "object") return;
          const name = typeof sk.name === "string" ? sk.name : "(unnamed skill)";
          const domain = typeof sk.domain === "string" ? sk.domain : undefined;
          const standardCode = cleanStandard(sk.standardCode);
          const key = `${name}|${domain || ""}|${standardCode || ""}`;
          let skillId = seen.get(key);
          if (!skillId) {
            skillId = typeof sk.id === "string" ? sk.id : uid();
            seen.set(key, skillId);
            lifted.push({ id: skillId, name, domain, standardCode, classIds: [cl.id] });
          } else {
            const ref = lifted.find((s) => s.id === skillId);
            if (ref && Array.isArray(ref.classIds) && !ref.classIds.includes(cl.id)) ref.classIds.push(cl.id);
          }
        });
        // Clear legacy per-class list to avoid confusion
        if (cl && typeof cl === "object") cl.skills = [];
      });
      st.skills = lifted.length ? lifted : DEFAULT_STATE().skills;
    }

    // Normalize each class
    st.classes = st.classes.map((cl) => {
      const rows = Number.isFinite(cl.rows) ? Math.max(1, Math.min(24, cl.rows)) : 4;
      const cols = Number.isFinite(cl.cols) ? Math.max(1, Math.min(24, cl.cols)) : 6;
      const seats = Array.isArray(cl.seats) ? cl.seats : [];
      const students = Array.isArray(cl.students) ? cl.students : [];
      const marks = (cl.marks && typeof cl.marks === "object") ? cl.marks : {};
      const layoutMode = cl.layoutMode === "free" ? "free" : "grid";
      // Ensure seats have r,c,studentId; x,y optional
      const normSeats = [];
      for (let i = 0; i < rows * cols; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const existing = seats.find((s) => s && s.r === r && s.c === c);
        const seat = existing ? existing : { r, c, studentId: null };
        if (typeof seat.studentId !== "string") seat.studentId = seat.studentId || null;
        if (typeof seat.x !== "number" || typeof seat.y !== "number") {
          // x,y will be set lazily when switching to free layout
        }
        normSeats.push(seat);
      }
      return {
        id: typeof cl.id === "string" ? cl.id : uid(),
        name: typeof cl.name === "string" ? cl.name : "Class",
        rows, cols,
        seats: normSeats,
        students: students.filter((s) => s && typeof s === "object" && typeof s.id === "string"),
        marks,
        layoutMode,
      };
    });

    // Ensure selected class
    if (!st.selectedClassId || !st.classes.find((c) => c.id === st.selectedClassId)) {
      st.selectedClassId = st.classes[0]?.id || DEFAULT_STATE().classes[0].id;
    }

    // Ensure selected skill (must belong to the selected class)
    const classSkills = st.skills.filter((s) => Array.isArray(s.classIds) && s.classIds.includes(st.selectedClassId));
    if (!st.selectedSkillId || !st.skills.find((s) => s.id === st.selectedSkillId)) {
      st.selectedSkillId = classSkills[0]?.id || st.skills[0]?.id || null;
    }

    return st;
  } catch (e) {
    // If anything goes wrong, fall back safely
    return DEFAULT_STATE();
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return DEFAULT_STATE();
    return migrateLegacy(raw);
  } catch (e) {
    return DEFAULT_STATE();
  }
}

function saveState(state) {
  try { localStorage.setItem(lsKey, JSON.stringify(state)); } catch {}
}

// ---------- Level palette ----------
const levelMeta = {
  0: { name: "N/A", bg: "bg-gray-100", ring: "ring-gray-300", text: "text-gray-600" },
  1: { name: "Help", bg: "bg-red-100", ring: "ring-red-300", text: "text-red-800" },
  2: { name: "Developing", bg: "bg-amber-100", ring: "ring-amber-300", text: "text-amber-800" },
  3: { name: "Proficient", bg: "bg-green-100", ring: "ring-green-300", text: "text-green-800" },
  4: { name: "Advanced", bg: "bg-blue-100", ring: "ring-blue-300", text: "text-blue-800" },
};

// ---------- Main App ----------
export default function App(){
  const [state, setState] = useState(loadState());
  const currentClass = useMemo(() => state.classes.find((c) => c.id === state.selectedClassId), [state]);
  const classSkills = useMemo(() => state.skills.filter((s) => s.classIds.includes(state.selectedClassId)), [state]);
  const selectedSkill = classSkills.find((s)=> s.id === state.selectedSkillId) || classSkills[0] || null;

  useEffect(()=> saveState(state), [state]);

  // Guard: ensure a valid selected skill for the chosen class
  useEffect(()=>{
    if (!selectedSkill && classSkills[0]) {
      setState((p)=> ({ ...p, selectedSkillId: classSkills[0].id }));
    }
  }, [selectedSkill, classSkills]);

  if (!currentClass) return <div className="p-6">No class selected.</div>;

  // ----- Level & seat helpers -----
  const studentName = (id) => currentClass.students.find((s) => s.id === id)?.name ?? "";
  const getLevel = (studentId) => {
    if (!studentId || !selectedSkill) return 0;
    const lv = currentClass.marks[selectedSkill.id]?.[studentId];
    return typeof lv === "number" ? lv : 0;
  };

  const cycleSeatLevel = (studentId) => {
    if (!selectedSkill) return;
    setState((prev) => {
      const next = { ...prev };
      const cls = next.classes.find((c) => c.id === prev.selectedClassId);
      if (!cls) return prev;
      const cur = cls.marks[selectedSkill.id]?.[studentId] ?? 0;
      const newLevel = (cur + 1) % 5;
      if (!cls.marks[selectedSkill.id]) cls.marks[selectedSkill.id] = {};
      cls.marks[selectedSkill.id][studentId] = newLevel;
      return next;
    });
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `monitoring-seating-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = migrateLegacy(String(reader.result));
        setState(parsed);
      } catch { alert("Invalid JSON file."); }
    };
    reader.readAsText(file);
  };

  const setClass = (id) => setState((p)=> ({ ...p, selectedClassId: id }));
  const setSkill = (id) => setState((p)=> ({ ...p, selectedSkillId: id }));

  // ----- Class & Skill management -----
  const addClass = () => {
    const name = prompt("New class name?"); if (!name) return;
    const rows = 4, cols = 6;
    const seats = Array.from({ length: rows * cols }, (_, i) => ({ r: Math.floor(i / cols), c: i % cols, studentId: null }));
    const students = [];
    const marks = {};
    const id = uid();
    setState((p)=> ({ ...p, classes: [...p.classes, { id, name, rows, cols, seats, students, marks, layoutMode: 'grid' }], selectedClassId: id }));
  };

  const renameClass = () => {
    const name = prompt("Rename class", currentClass.name); if (!name) return;
    setState((p)=> ({ ...p, classes: p.classes.map((c)=> c.id===currentClass.id ? { ...c, name } : c) }));
  };

  const addSkill = () => {
    const name = prompt("New skill name?"); if (!name) return;
    const domain = prompt(`Domain? (optional)\nOptions: ${NC_DOMAINS.join("; ")}`) || "";
    const standardCode = prompt("Standard code? (e.g., RP.2, EE.3) Optional") || "";
    setState((p)=> ({
      ...p,
      skills: [...p.skills, { id: uid(), name, domain: domain || undefined, standardCode: cleanStandard(standardCode), classIds: [p.selectedClassId] }],
    }));
  };

  const renameSkill = () => {
    if (!selectedSkill) return;
    const name = prompt("Rename skill", selectedSkill.name); if (!name) return;
    setState((p)=> ({ ...p, skills: p.skills.map((s)=> s.id===selectedSkill.id ? { ...s, name } : s) }));
  };

  const editSkillMeta = () => {
    if (!selectedSkill) return;
    const domain = prompt(`Domain? (blank = keep)\nCurrent: ${selectedSkill.domain || ""}\nOptions: ${NC_DOMAINS.join("; ")}`) || selectedSkill.domain || "";
    const standardCode = prompt(`Standard code? (e.g., RP.2)\nCurrent: ${selectedSkill.standardCode || ""}`) || selectedSkill.standardCode || "";
    setState((p)=> ({ ...p, skills: p.skills.map((s)=> s.id===selectedSkill.id ? { ...s, domain: domain || undefined, standardCode: cleanStandard(standardCode) } : s) }));
  };

  const linkSkillToClasses = () => {
    if (!selectedSkill) return;
    const currentNames = selectedSkill.classIds.map((id)=> pClassName(state, id)).join(", ");
    const names = prompt(`Link skill to which classes?\nSeparate names by commas.\nCurrent: ${currentNames}`);
    if (names == null) return;
    const wanted = names.split(",").map((s)=>s.trim()).filter(Boolean);
    const ids = state.classes.filter((cl)=> wanted.includes(cl.name)).map((cl)=> cl.id);
    if (!ids.length) { alert("No matching class names found."); return; }
    setState((p)=> ({ ...p, skills: p.skills.map((s)=> s.id===selectedSkill.id ? { ...s, classIds: Array.from(new Set(ids)) } : s) }));
  };

  const pClassName = (st, id) => st.classes.find((c)=>c.id===id)?.name || id;

  // ----- Grid: swap seats mode -----
  const [moveMode, setMoveMode] = useState(false);
  const [moveSource, setMoveSource] = useState(null); // {r,c}

  const swapSeats = (a, b) => {
    setState((prev) => {
      const next = { ...prev };
      const idx = next.classes.findIndex((c)=> c.id === prev.selectedClassId);
      if (idx < 0) return prev;
      const cls = { ...next.classes[idx] };
      const seats = cls.seats.map((s)=> ({...s}));
      const sa = seats.find((s)=> s.r===a.r && s.c===a.c);
      const sb = seats.find((s)=> s.r===b.r && s.c===b.c);
      if (!sa || !sb) return prev;
      const tmp = sa.studentId; sa.studentId = sb.studentId; sb.studentId = tmp;
      cls.seats = seats; next.classes[idx] = cls; return next;
    });
  };

  const onSeatClickGrid = (seat) => {
    if (moveMode) {
      if (!moveSource) { setMoveSource({ r: seat.r, c: seat.c }); return; }
      swapSeats(moveSource, seat); setMoveSource(null); return;
    }
    if (seat.studentId) cycleSeatLevel(seat.studentId);
  };

  // ----- Free Layout: drag desks anywhere -----
  const boardRef = useRef(null);
  const [dragging, setDragging] = useState(null); // {r,c}

  const ensureXYForAll = () => {
    // Initialize x/y from grid when entering free mode the first time
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      let changed = false;
      cls.seats = cls.seats.map((s) => {
        if (typeof s.x === "number" && typeof s.y === "number") return s;
        const x = (s.c + 0.5) / cls.cols;
        const y = (s.r + 0.5) / cls.rows;
        changed = true;
        return { ...s, x, y };
      });
      if (changed) { next.classes[idx] = cls; }
      return next;
    });
  };

  const setLayoutMode = (mode) => {
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx], layoutMode: mode };
      next.classes[idx] = cls;
      return next;
    });
    if (mode === "free") ensureXYForAll();
  };

  const onPointerDownSeat = (e, seat) => {
    if (currentClass.layoutMode !== "free") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging({ r: seat.r, c: seat.c });
  };

  const onPointerMoveBoard = (e) => {
    if (currentClass.layoutMode !== "free" || !dragging) return;
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const clampedX = Math.max(0.02, Math.min(0.98, x));
    const clampedY = Math.max(0.02, Math.min(0.98, y));
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      cls.seats = cls.seats.map((s)=> (s.r===dragging.r && s.c===dragging.c ? { ...s, x: clampedX, y: clampedY } : s));
      next.classes[idx] = cls; return next;
    });
  };

  const onPointerUpBoard = () => setDragging(null);

  // ----- Resize grid -----
  const [rows, setRows] = useState(currentClass.rows);
  const [cols, setCols] = useState(currentClass.cols);
  useEffect(()=>{ setRows(currentClass.rows); setCols(currentClass.cols); }, [currentClass.rows, currentClass.cols]);

  const applySize = () => {
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      const seats = [];
      for (let r=0; r<rows; r++) {
        for (let c=0; c<cols; c++) {
          const existing = cls.seats.find((s)=> s.r===r && s.c===c);
          if (existing) { seats.push(existing); }
          else { seats.push({ r, c, studentId: null }); }
        }
      }
      cls.rows = rows; cls.cols = cols; cls.seats = seats;
      next.classes[idx] = cls; return next;
    });
  };

  // ----- Assign Seat Modal -----
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignPos, setAssignPos] = useState(null);
  const [filter, setFilter] = useState("");

  const openAssignModal = (pos) => { setAssignPos(pos); setAssignOpen(true); };
  const assignSeat = (studentId) => {
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      cls.seats = cls.seats.map((s)=> (assignPos && s.r===assignPos.r && s.c===assignPos.c ? { ...s, studentId } : s));
      next.classes[idx] = cls; return next;
    });
    setAssignOpen(false);
  };

  const assignedIds = new Set(currentClass.seats.map((s)=> s.studentId).filter(Boolean));
  const filteredStudents = currentClass.students
    .filter((s)=> s.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=> a.name.localeCompare(b.name));

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-50 to-slate-100 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Academic Monitoring — Seating Chart</h1>
            <p className="text-sm text-gray-600">Tap seats to cycle levels • Swap seats in Grid • Drag desks in Free Layout • Link skills across classes.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportJSON} className="inline-flex items-center gap-2 rounded-2xl px-3 py-2 shadow-sm bg-white hover:bg-slate-50 border"><Download className="h-4 w-4"/>Export</button>
            <label className="inline-flex items-center gap-2 rounded-2xl px-3 py-2 shadow-sm bg-white hover:bg-slate-50 border cursor-pointer">
              <Upload className="h-4 w-4"/>Import
              <input type="file" accept="application/json" className="hidden" onChange={(e)=>{const f=e.target.files?.[0]; if(f) importJSON(f);}} />
            </label>
          </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3 rounded-2xl bg-white p-3 shadow-sm border">
            <div className="flex flex-wrap items-center gap-3">
              {/* Class Select */}
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-gray-500"/>
                <select className="rounded-xl border px-3 py-2 text-sm" value={state.selectedClassId} onChange={(e)=>setClass(e.target.value)}>
                  {state.classes.map((cl)=> (<option key={cl.id} value={cl.id}>{cl.name}</option>))}
                </select>
                <button onClick={addClass} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><Plus className="h-3 w-3"/>Add</button>
                <button onClick={renameClass} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><Pencil className="h-3 w-3"/>Rename</button>
              </div>

              {/* Skill Select + actions */}
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-gray-500"/>
                <select className="rounded-xl border px-3 py-2 text-sm" value={state.selectedSkillId || ""} onChange={(e)=>setSkill(e.target.value)}>
                  {classSkills.length===0 && <option value="">(No skills linked to this class)</option>}
                  {classSkills.map((sk)=> (
                    <option key={sk.id} value={sk.id}>{sk.name}{sk.standardCode?` — ${sk.standardCode}`:""}</option>
                  ))}
                </select>
                <button onClick={addSkill} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><Plus className="h-3 w-3"/>Add</button>
                <button onClick={renameSkill} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><Pencil className="h-3 w-3"/>Rename</button>
                <button onClick={editSkillMeta} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><SlidersHorizontal className="h-3 w-3"/>Meta</button>
                <button onClick={linkSkillToClasses} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50"><LinkIcon className="h-3 w-3"/>Link</button>
              </div>

              {/* Layout modes */}
              <div className="ml-auto flex items-center gap-2">
                <button onClick={()=>{ setMoveMode(!moveMode); setDragging(null); }} className={`inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs ${moveMode?"bg-blue-50 border-blue-300":"hover:bg-slate-50"}`}>
                  <Move3D className="h-3 w-3"/> {moveMode?"Move Seats: ON":"Move Seats"}
                </button>
                <button onClick={()=> setLayoutMode(currentClass.layoutMode==='grid'?'free':'grid')} className="inline-flex items-center gap-1 rounded-xl border px-2 py-1 text-xs hover:bg-slate-50">
                  <LayoutTemplate className="h-3 w-3"/> Layout: {currentClass.layoutMode==='grid'?"Grid":"Free"}
                </button>
              </div>

              <Legend />
            </div>
          </div>

          {/* Roster & Tools */}
          <div className="rounded-2xl bg-white p-3 shadow-sm border">
            <EditorPanel state={state} setState={setState} />
          </div>
        </div>

        {/* Seating Area */}
        <div className="rounded-3xl bg-white p-4 shadow-sm border">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge>Rows: {currentClass.rows}</Badge>
              <Badge>Cols: {currentClass.cols}</Badge>
              <Badge>Skill: {selectedSkill?.name ?? "—"}</Badge>
              {selectedSkill?.standardCode && <Badge>Std: {selectedSkill.standardCode}</Badge>}
              {selectedSkill?.domain && <Badge>Domain: {selectedSkill.domain}</Badge>}
            </div>
            <ResizeLayout rows={rows} cols={cols} setRows={setRows} setCols={setCols} apply={applySize} />
          </div>

          {currentClass.layoutMode === 'grid' ? (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${currentClass.cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: currentClass.rows * currentClass.cols }, (_, idx) => {
                const r = Math.floor(idx / currentClass.cols);
                const c = idx % currentClass.cols;
                const seat = currentClass.seats.find((s) => s.r === r && s.c === c) || { r, c, studentId: null };
                const lv = getLevel(seat.studentId);
                const meta = levelMeta[lv];
                const name = studentName(seat.studentId);
                const selected = moveMode && moveSource && moveSource.r===r && moveSource.c===c;
                return (
                  <button
                    key={`${r}-${c}`}
                    className={`relative rounded-2xl p-3 h-20 ring-2 ${meta.ring} ${meta.bg} transition focus:outline-none hover:brightness-95 ${selected?"outline outline-2 outline-blue-400": ""}`}
                    onClick={()=> onSeatClickGrid(seat)}
                    onDoubleClick={()=> openAssignModal({ r, c })}
                    onContextMenu={(e)=>{ e.preventDefault(); openAssignModal({ r, c }); }}
                    title={seat.studentId ? (moveMode?"Move or swap this seat":"Tap to cycle level") : (moveMode?"Move" : "Assign student")}
                  >
                    <div className="text-xs text-gray-500 absolute top-1 right-2">{r+1},{c+1}</div>
                    <div className={`text-sm font-semibold ${meta.text} line-clamp-2 pr-6`}>{name || "(empty)"}</div>
                    <div className="absolute bottom-2 right-2 text-[10px] text-gray-500">{meta.name}</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              ref={boardRef}
              onPointerMove={onPointerMoveBoard}
              onPointerUp={onPointerUpBoard}
              className="relative w-full border rounded-2xl"
              style={{ height: 420 }}
            >
              {currentClass.seats.map((s) => {
                const x = (typeof s.x === 'number') ? s.x : (s.c + 0.5) / currentClass.cols;
                const y = (typeof s.y === 'number') ? s.y : (s.r + 0.5) / currentClass.rows;
                const lv = getLevel(s.studentId);
                const meta = levelMeta[lv];
                const name = studentName(s.studentId);
                return (
                  <button
                    key={`${s.r}-${s.c}`}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl p-3 h-20 w-36 ring-2 ${meta.ring} ${meta.bg} transition focus:outline-none hover:brightness-95`}
                    style={{ left: `${x*100}%`, top: `${y*100}%` }}
                    onPointerDown={(e)=> onPointerDownSeat(e, s)}
                    onDoubleClick={()=> openAssignModal({ r: s.r, c: s.c })}
                    onContextMenu={(e)=>{ e.preventDefault(); openAssignModal({ r: s.r, c: s.c }); }}
                    onClick={()=> { if (!dragging && s.studentId) cycleSeatLevel(s.studentId); }}
                    title={s.studentId ? "Drag to move; tap to cycle level" : "Drag to place; double-tap to assign"}
                  >
                    <div className="text-xs text-gray-500 absolute top-1 right-2">{s.r+1},{s.c+1}</div>
                    <div className={`text-sm font-semibold ${meta.text} line-clamp-2 pr-6`}>{name || "(empty)"}</div>
                    <div className="absolute bottom-2 right-2 text-[10px] text-gray-500">{meta.name}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Assign Seat Modal */}
      {assignOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold">Assign seat ({assignPos.r+1},{assignPos.c+1})</h4>
              <button className="text-sm text-gray-500" onClick={()=>setAssignOpen(false)}>Close</button>
            </div>
            <input value={filter} onChange={(e)=>setFilter(e.target.value)} placeholder="Search student" className="w-full rounded-xl border px-3 py-2 text-sm" />
            <div className="mt-3 max-h-64 overflow-y-auto divide-y">
              <button className="w-full text-left py-2 px-2 hover:bg-slate-50 text-sm" onClick={()=>assignSeat(null)}>(empty)</button>
              {filteredStudents.map((s)=> (
                <button key={s.id} className={`w-full text-left py-2 px-2 hover:bg-slate-50 text-sm flex items-center justify-between ${assignedIds.has(s.id)?"opacity-60":""}`} onClick={()=>assignSeat(s.id)} disabled={assignedIds.has(s.id)}>
                  <span>{s.name}</span>
                  {assignedIds.has(s.id) && <span className="text-xs text-gray-500">assigned</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Small UI helpers ----------
function Badge({ children }){ return <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100">{children}</span>; }

function Legend(){
  return (
    <div className="flex items-center gap-2 ml-auto">
      {Object.entries(levelMeta).map(([k,m])=> (
        <div key={k} className="flex items-center gap-1">
          <span className={`h-3 w-3 inline-block rounded ${m.bg} ring-1 ${m.ring}`}></span>
          <span className="text-xs text-gray-600">{m.name}</span>
        </div>
      ))}
    </div>
  );
}

function ResizeLayout({ rows, cols, setRows, setCols, apply }){
  return (
    <div className="flex items-center gap-2">
      <input type="number" min={1} max={24} value={rows} onChange={(e)=>setRows(parseInt(e.target.value||"1"))} className="w-20 rounded-xl border px-2 py-1 text-sm" />
      <span className="text-sm text-gray-600">×</span>
      <input type="number" min={1} max={24} value={cols} onChange={(e)=>setCols(parseInt(e.target.value||"1"))} className="w-20 rounded-xl border px-2 py-1 text-sm" />
      <button onClick={apply} className="rounded-xl border px-3 py-1 text-sm hover:bg-slate-50">Apply</button>
    </div>
  );
}

function EditorPanel({ state, setState }){
  const cl = state.classes.find((c)=> c.id===state.selectedClassId);
  const [newName, setNewName] = useState("");

  const addStudent = () => {
    if (!newName.trim()) return;
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      const stu = { id: uid(), name: newName.trim() };
      cls.students = [...cls.students, stu];
      next.classes[idx] = cls; return next;
    });
    setNewName("");
  };

  const clearMarks = () => {
    const stSk = state.skills.find((s)=> s.id===state.selectedSkillId);
    if (!stSk) return;
    if (!confirm("Clear marks for current skill?")) return;
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      cls.marks = { ...cls.marks, [stSk.id]: {} };
      next.classes[idx] = cls; return next;
    });
  };

  const clearAllForStudent = (studentId) => {
    setState((p)=>{
      const next = { ...p };
      const idx = next.classes.findIndex((c)=> c.id===p.selectedClassId);
      if (idx<0) return p;
      const cls = { ...next.classes[idx] };
      for (const key of Object.keys(cls.marks)) { if (cls.marks[key] && studentId in cls.marks[key]) delete cls.marks[key][studentId]; }
      next.classes[idx] = cls; return next;
    });
  };

  return (
    <div>
      <h3 className="font-semibold mb-2">Roster & Tools</h3>
      <div className="flex items-center gap-2 mb-2">
        <input value={newName} onChange={(e)=>setNewName(e.target.value)} placeholder="First Last" className="flex-1 rounded-xl border px-2 py-1 text-sm" />
        <button onClick={addStudent} className="rounded-xl border px-2 py-1 text-sm hover:bg-slate-50">Add</button>
      </div>
      <div className="flex items-center justify-between mb-2 text-sm">
        <span className="text-gray-600">Assign a seat</span>
        <span className="text-xs text-gray-500">Double-click a seat (or right-click) to assign</span>
      </div>
      <div className="mb-2">
        <button onClick={clearMarks} className="rounded-xl border px-2 py-1 text-sm hover:bg-slate-50">Reset current layer</button>
      </div>
      <div className="mt-3 max-h-60 overflow-y-auto divide-y">
        {cl.students.map((s)=> (
          <div key={s.id} className="py-2 flex items-center justify-between">
            <div className="text-sm">{s.name}</div>
            <button className="text-xs text-red-600 hover:underline" onClick={()=>clearAllForStudent(s.id)}>Clear all</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Lightweight Runtime Tests (migrateLegacy) ----------
(function runTests(){
  // Test 1: handles malformed input gracefully
  const bad = JSON.stringify({ classes: [{ id: "A", name: 123, rows: "x", cols: null, seats: [{}], students: [{}] }], skills: [{ id: 1, name: 2, standardCode: 3, classIds: "nope" }] });
  const s1 = migrateLegacy(bad);
  console.assert(Array.isArray(s1.classes) && s1.classes.length >= 1, "Test1: classes present");
  console.assert(Array.isArray(s1.skills) && s1.skills.length >= 1, "Test1: skills present");

  // Test 2: strips NC.7 prefix
  const raw2 = JSON.stringify({ classes: [{ id: "C1", rows: 1, cols: 1, seats: [{ r:0, c:0, studentId:null }], students: [], marks: {}, skills: [{ id: "k1", name: "Old", standardCode: "NC.7.RP.2" }] }], selectedClassId: "C1" });
  const s2 = migrateLegacy(raw2);
  const anyStd = (s2.skills.find((x)=>x.standardCode) || {}).standardCode || "";
  console.assert(!anyStd.startsWith("NC.7."), "Test2: NC.7 stripped");

  // Test 3: legacy per-class skills lifted
  const raw3 = JSON.stringify({ classes: [{ id: "C2", rows: 1, cols: 1, seats: [{ r:0, c:0, studentId:null }], students: [], marks: {}, skills: [{ name: "X", standardCode: "EE.3" }] }] });
  const s3 = migrateLegacy(raw3);
  console.assert(Array.isArray(s3.skills) && s3.skills.length >= 1, "Test3: lifted skills");

  // Test 4: selectedSkillId points to an existing skill or null (no throw)
  const s4 = migrateLegacy(JSON.stringify({}));
  console.assert("selectedSkillId" in s4, "Test4: selectedSkillId exists");
})();
