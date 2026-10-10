package fr.sirius_assistant.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class UtteranceSegmenterTest {
    private static final short QUIET = 50;
    private static final short LOUD = 6000;

    private static short[] frame(short amplitude, short marker) {
        short[] f = new short[UtteranceSegmenter.FRAME_SAMPLES];
        for (int i = 0; i < f.length; i++) f[i] = (short) (i % 2 == 0 ? amplitude : -amplitude);
        f[0] = marker;
        return f;
    }

    private static List<UtteranceSegmenter.Event> feed(UtteranceSegmenter s, short amplitude, short marker, int count) {
        List<UtteranceSegmenter.Event> events = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            UtteranceSegmenter.Event e = s.process(frame(amplitude, marker));
            if (e != null) events.add(e);
        }
        return events;
    }

    /** Calibre sur du silence puis lève la suppression et consomme la garde. */
    private static UtteranceSegmenter ready() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        assertTrue(s.isSuppressed());
        feed(s, QUIET, QUIET, UtteranceSegmenter.CALIBRATION_FRAMES);
        s.setSuppressed(false);
        feed(s, QUIET, QUIET, UtteranceSegmenter.GUARD_FRAMES);
        return s;
    }

    private static UtteranceSegmenter.Event only(List<UtteranceSegmenter.Event> events, UtteranceSegmenter.Type type) {
        UtteranceSegmenter.Event found = null;
        for (UtteranceSegmenter.Event e : events) {
            if (e.type == type) {
                assertNull("événement " + type + " en double", found);
                found = e;
            }
        }
        return found;
    }

    @Test
    public void silenceNeProduitAucunEnonce() {
        UtteranceSegmenter s = ready();
        assertTrue(feed(s, QUIET, QUIET, 1000).isEmpty());
    }

    @Test
    public void suppressionInitialeIgnoreLaParole() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        feed(s, QUIET, QUIET, UtteranceSegmenter.CALIBRATION_FRAMES);
        assertTrue(feed(s, LOUD, LOUD, 100).isEmpty());
        assertTrue(feed(s, QUIET, QUIET, 100).isEmpty());
    }

    @Test
    public void preRollDe500msEtFinSurSilence() {
        UtteranceSegmenter s = ready();
        final short preMarker = 7;
        final short speechMarker = 9;
        assertTrue(feed(s, QUIET, preMarker, 40).isEmpty());
        List<UtteranceSegmenter.Event> events = feed(s, LOUD, speechMarker, 50);
        assertNotNull(only(events, UtteranceSegmenter.Type.SPEECH_START));
        events.addAll(feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES - 1));
        assertNull(only(events, UtteranceSegmenter.Type.UTTERANCE));
        events.addAll(feed(s, QUIET, QUIET, 1));
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        assertFalse(u.maxLength);

        int n = UtteranceSegmenter.FRAME_SAMPLES;
        int frames = u.pcm.length / n;
        assertEquals(UtteranceSegmenter.PREROLL_FRAMES + 50 + UtteranceSegmenter.TRAILING_KEEP_FRAMES, frames);
        for (int i = 0; i < UtteranceSegmenter.PREROLL_FRAMES; i++) assertEquals(preMarker, u.pcm[i * n]);
        assertEquals(speechMarker, u.pcm[UtteranceSegmenter.PREROLL_FRAMES * n]);
        assertEquals(frames * UtteranceSegmenter.FRAME_MS, u.durationMs);
    }

    @Test
    public void dureeMaximaleDe15Secondes() {
        UtteranceSegmenter s = ready();
        feed(s, QUIET, QUIET, 30);
        List<UtteranceSegmenter.Event> events = feed(s, LOUD, LOUD, 2000);
        List<UtteranceSegmenter.Event> utterances = new ArrayList<>();
        for (UtteranceSegmenter.Event e : events) if (e.type == UtteranceSegmenter.Type.UTTERANCE) utterances.add(e);
        assertTrue(utterances.size() >= 2);
        UtteranceSegmenter.Event first = utterances.get(0);
        assertTrue(first.maxLength);
        assertEquals(UtteranceSegmenter.MAX_FRAMES * UtteranceSegmenter.FRAME_SAMPLES, first.pcm.length);
        assertEquals(15000, first.durationMs);
    }

    @Test
    public void bruitTropCourtEstRejete() {
        UtteranceSegmenter s = ready();
        List<UtteranceSegmenter.Event> events = feed(s, LOUD, LOUD, 5);
        events.addAll(feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES + 5));
        assertNotNull(only(events, UtteranceSegmenter.Type.SPEECH_START));
        assertNull(only(events, UtteranceSegmenter.Type.UTTERANCE));
        assertNotNull(only(events, UtteranceSegmenter.Type.DISCARDED));
    }

    @Test
    public void suppressionVideLesTamponsEtGardeApresReprise() {
        UtteranceSegmenter s = ready();
        feed(s, QUIET, QUIET, 30);
        List<UtteranceSegmenter.Event> events = feed(s, LOUD, LOUD, 40);
        assertNotNull(only(events, UtteranceSegmenter.Type.SPEECH_START));
        long epoch = s.epoch();

        s.setSuppressed(true);
        assertTrue(s.epoch() > epoch);
        assertTrue(feed(s, LOUD, LOUD, 200).isEmpty());

        s.setSuppressed(false);
        // Écho résiduel pendant la garde : pas de VAD, seul READY sort à la fin ; l'énoncé interrompu est perdu.
        List<UtteranceSegmenter.Event> guard = feed(s, LOUD, LOUD, UtteranceSegmenter.GUARD_FRAMES);
        assertEquals(1, guard.size());
        assertEquals(UtteranceSegmenter.Type.READY, guard.get(0).type);
        assertTrue(feed(s, QUIET, QUIET, 100).isEmpty());

        final short marker = 11;
        events = feed(s, LOUD, marker, 30);
        events.addAll(feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES));
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        assertEquals(UtteranceSegmenter.PREROLL_FRAMES + 30 + UtteranceSegmenter.TRAILING_KEEP_FRAMES,
            u.pcm.length / UtteranceSegmenter.FRAME_SAMPLES);
        assertEquals(QUIET, u.pcm[0]);
        assertEquals(marker, u.pcm[UtteranceSegmenter.PREROLL_FRAMES * UtteranceSegmenter.FRAME_SAMPLES]);
    }

    @Test
    public void seuilAdaptatifIgnoreLeBruitStationnaire() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        feed(s, (short) 800, (short) 800, UtteranceSegmenter.CALIBRATION_FRAMES);
        s.setSuppressed(false);
        List<UtteranceSegmenter.Event> noise = feed(s, (short) 800, (short) 800, 500);
        assertEquals(1, noise.size());
        assertEquals(UtteranceSegmenter.Type.READY, noise.get(0).type);
        List<UtteranceSegmenter.Event> events = feed(s, LOUD, LOUD, 20);
        assertNotNull(only(events, UtteranceSegmenter.Type.SPEECH_START));
    }

    @Test
    public void wavEnTeteRiffPcm16Mono16k() {
        short[] pcm = { 1, -2, 300 };
        byte[] wav = UtteranceSegmenter.toWav(pcm, 16000);
        assertEquals(44 + 6, wav.length);
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals("RIFF", new String(wav, 0, 4));
        assertEquals(36 + 6, b.getInt(4));
        assertEquals("WAVE", new String(wav, 8, 4));
        assertEquals(1, b.getShort(20));
        assertEquals(1, b.getShort(22));
        assertEquals(16000, b.getInt(24));
        assertEquals(32000, b.getInt(28));
        assertEquals(16, b.getShort(34));
        assertEquals("data", new String(wav, 36, 4));
        assertEquals(6, b.getInt(40));
        assertEquals(-2, b.getShort(46));
    }

    /** Trame unique : chaque échantillon encode l'index global de trame et sa position, énergie conservée. */
    private static short[] tagged(int frameNo, short amplitude) {
        short[] f = new short[UtteranceSegmenter.FRAME_SAMPLES];
        for (int i = 0; i < f.length; i++) {
            int tag = (frameNo * 7 + i) % 40;
            f[i] = (short) (i % 2 == 0 ? amplitude + tag : -amplitude - tag);
        }
        return f;
    }

    @Test
    public void echantillonsInitiauxEtPreRollIdentiquesEtMetadonnees() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        List<short[]> fed = new ArrayList<>();
        List<UtteranceSegmenter.Event> events = new ArrayList<>();
        int n = 0;
        for (; n < UtteranceSegmenter.CALIBRATION_FRAMES; n++) { fed.add(tagged(n, QUIET)); s.process(fed.get(n)); }
        s.setSuppressed(false);
        int guardEnd = n + UtteranceSegmenter.GUARD_FRAMES;
        for (; n < guardEnd; n++) {
            fed.add(tagged(n, QUIET));
            UtteranceSegmenter.Event e = s.process(fed.get(n));
            if (n < guardEnd - 1) assertNull(e);
            else assertEquals(UtteranceSegmenter.Type.READY, e.type);
        }
        int speechFrame = n + 40;
        int speechEnd = speechFrame + 50;
        int total = speechEnd + UtteranceSegmenter.SILENCE_END_FRAMES;
        for (; n < total; n++) {
            fed.add(tagged(n, n >= speechFrame && n < speechEnd ? LOUD : QUIET));
            UtteranceSegmenter.Event e = s.process(fed.get(n));
            if (e != null) events.add(e);
        }

        UtteranceSegmenter.Event start = only(events, UtteranceSegmenter.Type.SPEECH_START);
        assertEquals((long) speechFrame * UtteranceSegmenter.FRAME_MS, start.speechStartMs);
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        assertTrue(s.isCurrent(u));

        int firstFrame = speechFrame - UtteranceSegmenter.PREROLL_FRAMES;
        int frames = UtteranceSegmenter.PREROLL_FRAMES + 50 + UtteranceSegmenter.TRAILING_KEEP_FRAMES;
        short[] expected = new short[frames * UtteranceSegmenter.FRAME_SAMPLES];
        for (int i = 0; i < frames; i++) {
            System.arraycopy(fed.get(firstFrame + i), 0, expected, i * UtteranceSegmenter.FRAME_SAMPLES,
                UtteranceSegmenter.FRAME_SAMPLES);
        }
        assertTrue("PCM différent des trames capturées", Arrays.equals(expected, u.pcm));

        assertEquals(expected.length, u.sampleCount);
        assertEquals(UtteranceSegmenter.PREROLL_FRAMES * UtteranceSegmenter.FRAME_SAMPLES, u.preRollSamples);
        assertEquals((long) speechFrame * UtteranceSegmenter.FRAME_MS, u.speechStartMs);
        assertEquals((long) (firstFrame + frames) * UtteranceSegmenter.FRAME_MS, u.endedMs);
        assertEquals("silence", u.reason);
        assertFalse(u.maxLength);

        byte[] wav = UtteranceSegmenter.toWav(u.pcm, UtteranceSegmenter.SAMPLE_RATE);
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(u.sampleCount * 2, b.getInt(40));
        assertEquals(36 + u.sampleCount * 2, b.getInt(4));
        assertEquals(44 + u.sampleCount * 2, wav.length);
        for (int i = 0; i < u.sampleCount; i++) assertEquals(u.pcm[i], b.getShort(44 + i * 2));
    }

    @Test
    public void limiteMarqueeReasonLimit() {
        UtteranceSegmenter s = ready();
        feed(s, QUIET, QUIET, 30);
        UtteranceSegmenter.Event u = only(feed(s, LOUD, LOUD, UtteranceSegmenter.MAX_FRAMES),
            UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        assertEquals("limit", u.reason);
        assertEquals(UtteranceSegmenter.MAX_FRAMES * UtteranceSegmenter.FRAME_SAMPLES, u.sampleCount);
        assertEquals(u.speechStartMs - (long) u.preRollSamples * 1000 / UtteranceSegmenter.SAMPLE_RATE + 15000,
            u.endedMs);
    }

    @Test
    public void suppressionInvalideLesEvenementsEnVol() {
        UtteranceSegmenter s = ready();
        feed(s, QUIET, QUIET, 30);
        UtteranceSegmenter.Event start = only(feed(s, LOUD, LOUD, 40), UtteranceSegmenter.Type.SPEECH_START);
        List<UtteranceSegmenter.Event> events = feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES);
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertTrue(s.isCurrent(start));
        assertTrue(s.isCurrent(u));

        s.setSuppressed(true);
        assertFalse(s.isCurrent(start));
        assertFalse(s.isCurrent(u));
        s.setSuppressed(false);
        assertFalse("une reprise ne revalide pas une ancienne génération", s.isCurrent(u));
        assertFalse(s.isCurrent(null));
    }

    @Test
    public void readySeulementApresGardeSurTramesReelles() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        s.setSuppressed(false);
        // Reprise pendant la calibration : READY après calibration + garde, jamais avant.
        int total = UtteranceSegmenter.CALIBRATION_FRAMES + UtteranceSegmenter.GUARD_FRAMES;
        for (int i = 0; i < total - 1; i++) assertNull(s.process(frame(QUIET, QUIET)));
        UtteranceSegmenter.Event ready = s.process(frame(QUIET, QUIET));
        assertEquals(UtteranceSegmenter.Type.READY, ready.type);
        assertEquals((long) total * UtteranceSegmenter.FRAME_MS, ready.endedMs);
        assertTrue(s.isCurrent(ready));
    }

    @Test
    public void suspensionAvantFinDeGardeNEmetPasReadyEtInvalideLAncien() {
        UtteranceSegmenter s = ready();
        s.setSuppressed(true);
        s.setSuppressed(false);
        assertTrue(feed(s, QUIET, QUIET, UtteranceSegmenter.GUARD_FRAMES - 1).isEmpty());
        s.setSuppressed(true);
        assertTrue(feed(s, QUIET, QUIET, 100).isEmpty());
        s.setSuppressed(false);
        UtteranceSegmenter.Event ready = only(feed(s, QUIET, QUIET, UtteranceSegmenter.GUARD_FRAMES),
            UtteranceSegmenter.Type.READY);
        assertNotNull(ready);
        s.setSuppressed(true);
        assertFalse(s.isCurrent(ready));
    }

    @Test
    public void premiersMotsPendantLaGardeConservesDansLePreRoll() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        feed(s, QUIET, QUIET, UtteranceSegmenter.CALIBRATION_FRAMES);
        s.setSuppressed(false);
        int n = UtteranceSegmenter.CALIBRATION_FRAMES;
        List<short[]> guardFrames = new ArrayList<>();
        List<UtteranceSegmenter.Event> events = new ArrayList<>();
        // L'utilisateur parle dès la reprise : toute la garde est de la voix.
        for (int i = 0; i < UtteranceSegmenter.GUARD_FRAMES; i++, n++) {
            short[] f = tagged(n, LOUD);
            guardFrames.add(f);
            UtteranceSegmenter.Event e = s.process(f);
            if (e != null) events.add(e);
        }
        assertNotNull(only(events, UtteranceSegmenter.Type.READY));
        for (int i = 0; i < 40; i++, n++) {
            UtteranceSegmenter.Event e = s.process(tagged(n, LOUD));
            if (e != null) events.add(e);
        }
        events.addAll(feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES));
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        int f = UtteranceSegmenter.FRAME_SAMPLES;
        assertEquals(UtteranceSegmenter.GUARD_FRAMES * f, u.preRollSamples);
        for (int i = 0; i < guardFrames.size(); i++) {
            short[] got = Arrays.copyOfRange(u.pcm, i * f, (i + 1) * f);
            assertTrue("trame de garde " + i + " absente", Arrays.equals(guardFrames.get(i), got));
        }
        assertEquals((long) (UtteranceSegmenter.CALIBRATION_FRAMES + UtteranceSegmenter.GUARD_FRAMES)
            * UtteranceSegmenter.FRAME_MS, u.speechStartMs);
    }

    @Test
    public void paroleDesLOuvertureNeCalibrePasLeBruitEtGardeLeDebut() {
        UtteranceSegmenter s = new UtteranceSegmenter();
        s.setSuppressed(false);
        List<UtteranceSegmenter.Event> events = new ArrayList<>();
        int openingFrames = UtteranceSegmenter.CALIBRATION_FRAMES + UtteranceSegmenter.GUARD_FRAMES;
        List<short[]> opening = new ArrayList<>();
        for (int i = 0; i < openingFrames; i++) {
            short[] f = tagged(i, LOUD);
            opening.add(f);
            UtteranceSegmenter.Event e = s.process(f);
            if (e != null) events.add(e);
        }
        assertNotNull(only(events, UtteranceSegmenter.Type.READY));
        assertEquals(100.0, s.noiseFloor(), 0.01);
        events.addAll(feed(s, LOUD, LOUD, 30));
        events.addAll(feed(s, QUIET, QUIET, UtteranceSegmenter.SILENCE_END_FRAMES));
        UtteranceSegmenter.Event u = only(events, UtteranceSegmenter.Type.UTTERANCE);
        assertNotNull(u);
        for (int i = 0; i < opening.size(); i++) {
            short[] got = Arrays.copyOfRange(u.pcm, i * UtteranceSegmenter.FRAME_SAMPLES,
                (i + 1) * UtteranceSegmenter.FRAME_SAMPLES);
            assertTrue("début de phrase " + i + " absent", Arrays.equals(opening.get(i), got));
        }
    }
}
