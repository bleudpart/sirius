export const FLAT_EQUALIZER = { bass: 0, mid: 0, treble: 0 };
const bands = ["bass", "mid", "treble"];
const activeGraphs = new Set();
let context;

function normalize(value) {
  return Object.fromEntries(bands.map(key => [key,
    Number.isFinite(value?.[key]) ? Math.max(-12, Math.min(12, value[key])) : 0]));
}

export function loadVoiceEqualizer() {
  try {
    return normalize(JSON.parse(localStorage.getItem("sirius_voice_equalizer")));
  } catch (error) {
    console.warn("Égaliseur vocal : réglages illisibles.", error);
    return { ...FLAT_EQUALIZER };
  }
}

function apply(graph, config) {
  bands.forEach((key, index) => graph.filters[index].gain.setTargetAtTime(config[key], context.currentTime, 0.02));
  const boost = bands.reduce((sum, key) => sum + Math.max(0, config[key]), 0);
  graph.headroom.gain.setTargetAtTime(10 ** (-boost / 20), context.currentTime, 0.02);
}

export function saveVoiceEqualizer(value) {
  const config = normalize(value);
  localStorage.setItem("sirius_voice_equalizer", JSON.stringify(config));
  activeGraphs.forEach(graph => apply(graph, config));
  return config;
}

export async function connectVoiceEqualizer(audio) {
  const config = loadVoiceEqualizer();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    if (bands.some(key => config[key] !== 0)) {
      const message = "Égaliseur vocal indisponible dans ce navigateur : lecture sans égalisation.";
      console.warn(message);
      window.dispatchEvent(new CustomEvent("sirius-voice-error", { detail: message }));
    }
    return () => {};
  }
  context ||= new AudioContext();
  await context.resume();
  const source = context.createMediaElementSource(audio);
  const headroom = context.createGain();
  const filters = [
    ["lowshelf", 250],
    ["peaking", 1200],
    ["highshelf", 4000],
  ].map(([type, frequency]) => {
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.7;
    return filter;
  });
  source.connect(headroom);
  headroom.connect(filters[0]);
  filters[0].connect(filters[1]);
  filters[1].connect(filters[2]);
  filters[2].connect(context.destination);
  const graph = { filters, headroom };
  apply(graph, config);
  activeGraphs.add(graph);
  return () => {
    activeGraphs.delete(graph);
    [source, headroom, ...filters].forEach(node => node.disconnect());
  };
}
