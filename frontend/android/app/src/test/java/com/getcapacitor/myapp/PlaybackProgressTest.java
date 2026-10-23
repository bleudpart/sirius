package fr.sirius_assistant.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackProgressTest {
    @Test public void expiresOnlyAfterFifteenSecondsWithoutAudioProgress() {
        PlaybackProgress progress = new PlaybackProgress(1000);
        assertFalse(progress.stalled(0, 15999));
        assertTrue(progress.stalled(0, 16000));
    }

    @Test public void longSpeechDoesNotExpireWhileMediaPositionAdvances() {
        PlaybackProgress progress = new PlaybackProgress(0);
        for (int second = 1; second < 180; second++) {
            assertFalse(progress.stalled(second * 1000, second * 1000L));
        }
        assertFalse(progress.stalled(179000, 193999));
        assertTrue(progress.stalled(179000, 194000));
    }

    @Test public void delayedCallbackObservesActualAudioProgressBeforeExpiring() {
        PlaybackProgress progress = new PlaybackProgress(0);
        assertFalse(progress.stalled(60000, 60000));
        assertFalse(progress.stalled(60000, 74999));
        assertTrue(progress.stalled(60000, 75000));
    }
}
