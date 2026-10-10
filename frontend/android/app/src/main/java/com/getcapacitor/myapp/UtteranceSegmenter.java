package fr.sirius_assistant.app;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Segmenteur vocal pur Java (aucune dépendance Android) : VAD énergétique adaptative,
 * pré-roll, fin sur silence, durée maximale et suppression pendant la lecture audio.
 * La VAD compare le RMS de chaque trame à un plancher de bruit adaptatif ; ce n'est pas un
 * détecteur neuronal et elle ne distingue pas la voix d'un autre son de même énergie.
 * Toutes les méthodes publiques sont synchronisées : process() est appelé par le thread
 * de capture, setSuppressed() par le thread du plugin.
 */
public final class UtteranceSegmenter {
    public static final int SAMPLE_RATE = 16000;
    public static final int FRAME_MS = 20;
    public static final int FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;

    public static final int PREROLL_FRAMES = 25;          // 500 ms
    public static final int START_FRAMES = 3;             // 60 ms au-dessus du seuil pour déclencher
    public static final int SILENCE_END_FRAMES = 60;      // 1200 ms
    public static final int TRAILING_KEEP_FRAMES = 10;    // 200 ms de silence conservés en fin
    public static final int MAX_FRAMES = 750;             // 15 s, pré-roll inclus
    public static final int MIN_VOICED_FRAMES = 10;       // 200 ms de voix sinon rejet
    public static final int GUARD_FRAMES = 15;            // 300 ms ignorés après reprise
    public static final int CALIBRATION_FRAMES = 10;      // 200 ms de calibration du bruit

    static final double MIN_START_RMS = 300.0;
    static final double MIN_CONTINUE_RMS = 200.0;
    static final double START_FACTOR = 3.0;
    static final double CONTINUE_FACTOR = 2.0;
    static final double MIN_NOISE = 30.0;
    static final double MAX_NOISE = 4000.0;

    /** READY : garde post-reprise écoulée sur des trames réellement lues ; la VAD est active à partir de la trame suivante. */
    public enum Type { READY, SPEECH_START, UTTERANCE, DISCARDED }

    /**
     * Événement du segmenteur. Les temps (ms) sont sur l'horloge d'échantillons, monotone depuis la
     * première trame traitée de la session : trame n = n * FRAME_MS, indépendante de l'horloge murale.
     */
    public static final class Event {
        public final Type type;
        public final short[] pcm;
        public final int sampleCount;
        public final int preRollSamples;
        public final long speechStartMs;
        public final long endedMs;
        /** "silence" ou "limit" pour UTTERANCE/DISCARDED ; null pour READY et SPEECH_START. */
        public final String reason;
        public final int durationMs;
        public final boolean maxLength;
        public final long epoch;

        Event(Type type, short[] pcm, int sampleCount, int preRollSamples, long speechStartMs,
              long endedMs, String reason, long epoch) {
            this.type = type;
            this.pcm = pcm;
            this.sampleCount = sampleCount;
            this.preRollSamples = preRollSamples;
            this.speechStartMs = speechStartMs;
            this.endedMs = endedMs;
            this.reason = reason;
            this.durationMs = (int) ((long) sampleCount * 1000 / SAMPLE_RATE);
            this.maxLength = "limit".equals(reason);
            this.epoch = epoch;
        }
    }

    private final short[] ring = new short[(PREROLL_FRAMES + START_FRAMES) * FRAME_SAMPLES];
    private final int ringFrames = PREROLL_FRAMES + START_FRAMES;
    private int ringStart;
    private int ringCount;

    private final short[] utterance = new short[MAX_FRAMES * FRAME_SAMPLES];
    private int utteranceFrames;

    private boolean triggered;
    private int consecutiveVoiced;
    private int voicedFrames;
    private int silenceRun;

    private double noiseFloor = 100.0;
    private int calibrationCount;
    private int calibrationSamples;
    private double calibrationSum;

    private boolean suppressed = true;
    private int guardRemaining;
    private long epoch;

    private long frameIndex = -1;
    private long utteranceStartFrame;
    private int preRollFrames;

    public synchronized boolean isSuppressed() { return suppressed; }

    public synchronized long epoch() { return epoch; }

    /** Nombre de trames déjà traitées = index de la prochaine trame sur l'horloge d'échantillons. */
    public synchronized long framesProcessed() { return frameIndex + 1; }

    /** Vrai si l'événement appartient encore à la génération de suppression courante. */
    public synchronized boolean isCurrent(Event event) { return event != null && event.epoch == epoch; }

    public synchronized double noiseFloor() { return noiseFloor; }

    /** Change l'état de suppression ; vide les tampons dans tous les cas et arme une garde à la reprise. */
    public synchronized void setSuppressed(boolean value) {
        suppressed = value;
        epoch++;
        reset();
        guardRemaining = value ? 0 : GUARD_FRAMES;
    }

    /** Traite exactement une trame de FRAME_SAMPLES échantillons. Retourne un événement ou null. */
    public synchronized Event process(short[] frame) {
        if (frame == null || frame.length != FRAME_SAMPLES) {
            throw new IllegalArgumentException("Trame de " + FRAME_SAMPLES + " échantillons attendue.");
        }
        frameIndex++;
        double rms = rms(frame);
        if (calibrationCount < CALIBRATION_FRAMES) {
            if (suppressed) {
                calibrationSum += rms;
                calibrationSamples++;
            } else {
                // Une phrase commencée à l'ouverture n'est pas du bruit de fond.
                pushRing(frame);
            }
            calibrationCount++;
            if (calibrationCount == CALIBRATION_FRAMES && calibrationSamples > 0) {
                noiseFloor = clamp(calibrationSum / calibrationSamples);
            }
            return null;
        }
        if (suppressed) return null;
        if (guardRemaining > 0) {
            // Garde post-TTS : pas de VAD ni d'adaptation du bruit, mais l'audio frais alimente le pré-roll
            // pour que les premiers mots prononcés pendant ou juste après la garde ne soient pas perdus.
            pushRing(frame);
            guardRemaining--;
            if (guardRemaining > 0) return null;
            return new Event(Type.READY, null, 0, 0, 0, (frameIndex + 1) * FRAME_MS, null, epoch);
        }
        return triggered ? continueSpeech(frame, rms) : detectStart(frame, rms);
    }

    private Event detectStart(short[] frame, double rms) {
        pushRing(frame);
        if (rms >= Math.max(MIN_START_RMS, noiseFloor * START_FACTOR)) {
            consecutiveVoiced++;
        } else {
            consecutiveVoiced = 0;
            adaptNoise(rms);
        }
        if (consecutiveVoiced < START_FRAMES) return null;
        triggered = true;
        preRollFrames = ringCount - consecutiveVoiced;
        utteranceStartFrame = frameIndex - ringCount + 1;
        utteranceFrames = 0;
        for (int i = 0; i < ringCount; i++) {
            int slot = (ringStart + i) % ringFrames;
            System.arraycopy(ring, slot * FRAME_SAMPLES, utterance, utteranceFrames * FRAME_SAMPLES, FRAME_SAMPLES);
            utteranceFrames++;
        }
        ringStart = 0;
        ringCount = 0;
        voicedFrames = consecutiveVoiced;
        silenceRun = 0;
        return new Event(Type.SPEECH_START, null, 0, preRollFrames * FRAME_SAMPLES,
            speechStartMs(), (frameIndex + 1) * FRAME_MS, null, epoch);
    }

    private Event continueSpeech(short[] frame, double rms) {
        System.arraycopy(frame, 0, utterance, utteranceFrames * FRAME_SAMPLES, FRAME_SAMPLES);
        utteranceFrames++;
        if (rms >= Math.max(MIN_CONTINUE_RMS, noiseFloor * CONTINUE_FACTOR)) {
            voicedFrames++;
            silenceRun = 0;
        } else {
            silenceRun++;
        }
        if (utteranceFrames >= MAX_FRAMES) {
            return finish(utteranceFrames, "limit");
        }
        if (silenceRun >= SILENCE_END_FRAMES) {
            int keep = utteranceFrames - silenceRun + Math.min(silenceRun, TRAILING_KEEP_FRAMES);
            return finish(keep, "silence");
        }
        return null;
    }

    private Event finish(int frames, String reason) {
        boolean enough = voicedFrames >= MIN_VOICED_FRAMES;
        short[] pcm = null;
        if (enough) {
            pcm = new short[frames * FRAME_SAMPLES];
            System.arraycopy(utterance, 0, pcm, 0, pcm.length);
        }
        int samples = frames * FRAME_SAMPLES;
        int preRoll = preRollFrames * FRAME_SAMPLES;
        long start = speechStartMs();
        long ended = (utteranceStartFrame + frames) * FRAME_MS;
        reset();
        return new Event(enough ? Type.UTTERANCE : Type.DISCARDED, pcm, samples, preRoll, start, ended, reason, epoch);
    }

    private long speechStartMs() {
        return (utteranceStartFrame + preRollFrames) * FRAME_MS;
    }

    private void reset() {
        ringStart = 0;
        ringCount = 0;
        utteranceFrames = 0;
        triggered = false;
        consecutiveVoiced = 0;
        voicedFrames = 0;
        silenceRun = 0;
    }

    private void pushRing(short[] frame) {
        int slot;
        if (ringCount < ringFrames) {
            slot = (ringStart + ringCount) % ringFrames;
            ringCount++;
        } else {
            slot = ringStart;
            ringStart = (ringStart + 1) % ringFrames;
        }
        System.arraycopy(frame, 0, ring, slot * FRAME_SAMPLES, FRAME_SAMPLES);
    }

    private void adaptNoise(double rms) {
        double rate = rms < noiseFloor ? 0.2 : 0.02;
        noiseFloor = clamp(noiseFloor + (rms - noiseFloor) * rate);
    }

    private static double clamp(double value) {
        return Math.max(MIN_NOISE, Math.min(MAX_NOISE, value));
    }

    static double rms(short[] frame) {
        double sum = 0;
        for (short s : frame) sum += (double) s * s;
        return Math.sqrt(sum / frame.length);
    }

    /** Encode un PCM16 mono en WAV RIFF little-endian. */
    public static byte[] toWav(short[] pcm, int sampleRate) {
        int dataBytes = pcm.length * 2;
        ByteBuffer buffer = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(new byte[] { 'R', 'I', 'F', 'F' }).putInt(36 + dataBytes);
        buffer.put(new byte[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
        buffer.putInt(16).putShort((short) 1).putShort((short) 1);
        buffer.putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16);
        buffer.put(new byte[] { 'd', 'a', 't', 'a' }).putInt(dataBytes);
        for (short s : pcm) buffer.putShort(s);
        return buffer.array();
    }
}
