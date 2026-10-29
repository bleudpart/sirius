package fr.sirius_assistant.app;

import java.util.UUID;

final class HaccpPrinterRules {
    private HaccpPrinterRules() {}

    static String privateIpv4(String value) {
        if (value == null || !value.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
            throw new IllegalArgumentException("Adresse IPv4 LAN requise, sans URL ni nom d'hote.");
        }
        String[] parts = value.split("\\.");
        int[] ip = new int[4];
        for (int i = 0; i < 4; i++) {
            ip[i] = Integer.parseInt(parts[i]);
            if (ip[i] > 255 || !Integer.toString(ip[i]).equals(parts[i])) {
                throw new IllegalArgumentException("Adresse IPv4 invalide.");
            }
        }
        if (!(ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31)
                || (ip[0] == 192 && ip[1] == 168)) || ip[3] == 0 || ip[3] == 255) {
            throw new IllegalArgumentException("Imprimante : adresse privee LAN uniquement (10/8, 172.16/12, 192.168/16).");
        }
        return value;
    }

    static String jobId(String value) {
        if (value == null || !UUID.fromString(value).toString().equals(value)) {
            throw new IllegalArgumentException("Identifiant de demande invalide.");
        }
        return value;
    }

    static String text(String value, int max) {
        if (value == null || value.isEmpty() || value.length() > max
                || value.codePoints().anyMatch(c -> Character.isISOControl(c)
                    || c == 0x2028 || c == 0x2029 || (c >= 0x202a && c <= 0x202e)
                    || (c >= 0x2066 && c <= 0x2069))) {
            throw new IllegalArgumentException("Texte d'etiquette invalide ou trop long.");
        }
        return value;
    }
}
