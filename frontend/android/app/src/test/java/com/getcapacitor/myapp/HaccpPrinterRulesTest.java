package fr.sirius_assistant.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class HaccpPrinterRulesTest {
    @Test public void acceptsOnlyPrivateUnambiguousIpv4Hosts() {
        for (String ip : new String[] {"10.0.0.1", "172.16.0.1", "172.31.10.2", "192.168.1.50"}) {
            assertEquals(ip, HaccpPrinterRules.privateIpv4(ip));
        }
        for (String ip : new String[] {"8.8.8.8", "127.0.0.1", "169.254.1.2", "224.1.1.1",
                "172.15.0.1", "172.32.0.1", "192.168.1.255", "10.0.0.0", "10.0.0.999",
                "192.168.01.2", "https://192.168.1.2", "192.168.1.2:9100", "::1", "printer.local", ""}) {
            try { HaccpPrinterRules.privateIpv4(ip); fail(ip); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void rejectsControlCharactersAndTruncationRatherThanChangingLabel() {
        assertEquals("Saumon frais", HaccpPrinterRules.text("Saumon frais", 255));
        for (String value : new String[] {"", "line\nbreak", "\u202eTEST", "123456"}) {
            try { HaccpPrinterRules.text(value, 5); fail(value); }
            catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void requiresCanonicalJobUuid() {
        String id = "da892142-03f1-42ae-bd08-925340fca1db";
        assertEquals(id, HaccpPrinterRules.jobId(id));
        try { HaccpPrinterRules.jobId("1-1-1-1-1"); fail(); }
        catch (IllegalArgumentException expected) { }
    }

    @Test public void preparationIncludesExactTimesAndFullStorageInstructions() {
        String body = HaccpPrinterRules.labelBody(true, "PREP-TEST", "02/11/2026 08:15:00 +0100",
            "05/11/2026 08:15:00 +0100", "Cuisine", "Entre 0 et +3 C, en bac ferme.");
        assertTrue(body.contains("Fabrication : 02/11/2026 08:15:00 +0100"));
        assertTrue(body.contains("DLC : 05/11/2026 08:15:00 +0100"));
        assertTrue(body.contains("Conservation : Entre 0 et +3 C, en bac ferme."));
        assertFalse(body.contains("Ouvert"));
    }

    @Test public void preparationCannotOmitItsStorageConditions() {
        for (String storage : new String[] {null, "", "line\nbreak"}) {
            try {
                HaccpPrinterRules.labelBody(true, "LOT", "02/11/2026 08:00", "05/11/2026 08:00",
                    "Cuisine", storage);
                fail();
            } catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void openingKeepsItsExistingTextWithoutPreparationFields() {
        assertEquals("Lot : LOT\nOuvert : 02/11/2026 08:00\nAu plus tard : 05/11/2026 08:00\nOperateur : Cuisine",
            HaccpPrinterRules.labelBody(false, "LOT", "02/11/2026 08:00", "05/11/2026 08:00", "Cuisine", null));
    }
}
