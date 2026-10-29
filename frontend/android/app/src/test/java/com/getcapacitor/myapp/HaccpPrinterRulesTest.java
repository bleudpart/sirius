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
}
