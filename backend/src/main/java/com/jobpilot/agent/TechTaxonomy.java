package com.jobpilot.agent;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What technologies a piece of text mentions, and which of them are the same thing.
 *
 * This exists so the fit decision can be made WITHOUT a language model for the clear-cut cases.
 * A real run sent 173 job descriptions to a free-tier LLM, 95 of them came back unjudged because
 * the per-minute quota ran out, and the answers it did give were mostly of this form:
 *
 *     skip — stack mismatch — missing Python
 *     skip — stack mismatch — missing C++
 *     skip — stack mismatch — missing Flutter, Dart
 *
 * None of that needs a model. "The job requires Python and the candidate has none" is set
 * arithmetic, and doing it here makes it instant, free, deterministic and explainable.
 *
 * Two kinds of knowledge live here:
 *   ALIASES     — spellings of one technology ("node.js", "nodejs", "node" → node)
 *   IMPLIES     — what a framework tells you about the language (spring → java)
 * A CORE technology is one that decides whether a job is even plausible; everything else is
 * seasoning. "Missing Docker" never disqualifies a Java developer from a Java job.
 */
public final class TechTaxonomy {

    private TechTaxonomy() { }

    /**
     * Canonical name → every spelling seen in the wild. Order matters only for readability.
     *
     * Deliberately conservative: a term is only here when a false match would be embarrassing.
     * "go" and "r" are single letters/words that appear constantly in prose, so they are matched
     * by their unambiguous forms only ("golang", "r language").
     */
    private static final Map<String, List<String>> ALIASES = new LinkedHashMap<>();
    static {
        // --- languages (the ones that decide whether a job is plausible at all) ---
        ALIASES.put("java", List.of("java", "core java", "java8", "java 8", "java11", "java 11", "java17", "java 17", "j2ee"));
        ALIASES.put("python", List.of("python", "python3", "py3"));
        ALIASES.put("javascript", List.of("javascript", "java script", "es6", "ecmascript", "vanilla js"));
        ALIASES.put("typescript", List.of("typescript", "ts "));
        ALIASES.put("csharp", List.of("c#", "c sharp", "csharp", ".net", "dotnet", "dot net", "asp.net", "asp net"));
        ALIASES.put("cpp", List.of("c++", "cpp"));
        ALIASES.put("golang", List.of("golang", "go lang", "go language"));
        ALIASES.put("ruby", List.of("ruby"));
        ALIASES.put("php", List.of("php"));
        ALIASES.put("kotlin", List.of("kotlin"));
        ALIASES.put("swift", List.of("swift", "swiftui"));
        ALIASES.put("scala", List.of("scala"));
        ALIASES.put("rust", List.of("rust"));
        ALIASES.put("dart", List.of("dart"));
        ALIASES.put("perl", List.of("perl"));
        ALIASES.put("abap", List.of("abap"));
        ALIASES.put("rpg", List.of("rpgle", "rpg iv", "rpg developer"));
        ALIASES.put("cobol", List.of("cobol"));
        ALIASES.put("salesforce", List.of("salesforce", "apex", "lightning web component", "lwc"));
        ALIASES.put("servicenow", List.of("servicenow", "service now"));
        ALIASES.put("sap", List.of("sap", "s/4hana", "s4hana"));

        // --- frameworks / runtimes ---
        ALIASES.put("spring", List.of("spring", "spring boot", "springboot", "spring mvc", "spring cloud"));
        ALIASES.put("node", List.of("node.js", "nodejs", "node js", "node "));
        ALIASES.put("express", List.of("express.js", "expressjs", "express "));
        ALIASES.put("nestjs", List.of("nest.js", "nestjs"));
        ALIASES.put("react", List.of("react", "react.js", "reactjs", "react js"));
        ALIASES.put("nextjs", List.of("next.js", "nextjs"));
        ALIASES.put("angular", List.of("angular", "angularjs"));
        ALIASES.put("vue", List.of("vue", "vue.js", "vuejs"));
        ALIASES.put("svelte", List.of("svelte"));
        ALIASES.put("django", List.of("django"));
        ALIASES.put("flask", List.of("flask"));
        ALIASES.put("fastapi", List.of("fastapi", "fast api"));
        ALIASES.put("rails", List.of("rails", "ruby on rails"));
        ALIASES.put("laravel", List.of("laravel"));
        ALIASES.put("codeigniter", List.of("codeigniter", "code igniter"));
        ALIASES.put("drupal", List.of("drupal"));
        ALIASES.put("wordpress", List.of("wordpress"));
        ALIASES.put("flutter", List.of("flutter"));
        ALIASES.put("reactnative", List.of("react native", "react-native"));
        ALIASES.put("android", List.of("android", "jetpack compose"));
        ALIASES.put("ios", List.of("ios ", "objective-c", "objective c"));
        ALIASES.put("hibernate", List.of("hibernate", "jpa"));
        ALIASES.put("dotnetcore", List.of(".net core", "dotnet core", "net core"));

        // --- data stores ---
        ALIASES.put("sql", List.of("sql", "mysql", "postgres", "postgresql", "oracle db", "plsql", "pl/sql", "sql server", "t-sql"));
        ALIASES.put("mongodb", List.of("mongodb", "mongo db", "mongo "));
        ALIASES.put("redis", List.of("redis"));
        ALIASES.put("elasticsearch", List.of("elasticsearch", "elastic search", "opensearch"));
        ALIASES.put("cassandra", List.of("cassandra"));
        ALIASES.put("dynamodb", List.of("dynamodb"));

        // --- infrastructure (rarely disqualifying, but worth recognising) ---
        ALIASES.put("aws", List.of("aws", "amazon web services"));
        ALIASES.put("azure", List.of("azure"));
        ALIASES.put("gcp", List.of("gcp", "google cloud"));
        ALIASES.put("docker", List.of("docker", "containeri"));
        ALIASES.put("kubernetes", List.of("kubernetes", "k8s"));
        ALIASES.put("terraform", List.of("terraform"));
        ALIASES.put("kafka", List.of("kafka"));
        ALIASES.put("graphql", List.of("graphql"));
        ALIASES.put("jenkins", List.of("jenkins"));
        ALIASES.put("spark", List.of("apache spark", "pyspark"));
        ALIASES.put("hadoop", List.of("hadoop"));
        ALIASES.put("databricks", List.of("databricks"));
        ALIASES.put("selenium", List.of("selenium"));
        ALIASES.put("playwright", List.of("playwright"));
    }

    /**
     * CORE technologies: the ones that decide whether a job is plausible for a candidate.
     *
     * A job asking for Python when you write Java is a different job. A job mentioning Docker
     * when you have not used Docker is the same job with a tool you would pick up in a week —
     * so infrastructure and tooling are deliberately NOT core. Getting this line wrong in the
     * generous direction wastes an application; getting it wrong in the strict direction throws
     * away a job you could do, which is what a 2%-relevant run looks like.
     */
    private static final Set<String> CORE = Set.of(
            "java", "python", "javascript", "typescript", "csharp", "cpp", "golang", "ruby",
            "php", "kotlin", "swift", "scala", "rust", "dart", "perl", "abap", "rpg", "cobol",
            "salesforce", "servicenow", "sap",
            "spring", "node", "react", "angular", "vue", "django", "flask", "fastapi", "rails",
            "laravel", "codeigniter", "drupal", "wordpress", "flutter", "reactnative",
            "android", "ios", "nextjs", "nestjs", "dotnetcore", "express", "svelte");

    /** A framework tells you the language. Someone asking for Spring is asking for Java. */
    private static final Map<String, String> IMPLIES = Map.ofEntries(
            Map.entry("spring", "java"), Map.entry("hibernate", "java"),
            Map.entry("django", "python"), Map.entry("flask", "python"), Map.entry("fastapi", "python"),
            Map.entry("rails", "ruby"),
            Map.entry("laravel", "php"), Map.entry("codeigniter", "php"), Map.entry("drupal", "php"),
            Map.entry("wordpress", "php"),
            Map.entry("react", "javascript"), Map.entry("angular", "javascript"),
            Map.entry("vue", "javascript"), Map.entry("svelte", "javascript"),
            Map.entry("nextjs", "javascript"), Map.entry("node", "javascript"),
            Map.entry("express", "javascript"), Map.entry("nestjs", "javascript"),
            Map.entry("dotnetcore", "csharp"),
            Map.entry("flutter", "dart"),
            Map.entry("reactnative", "javascript"));

    /** Compiled once: canonical name → a pattern matching any of its spellings on a word boundary. */
    private static final Map<String, Pattern> PATTERNS = new LinkedHashMap<>();
    static {
        for (Map.Entry<String, List<String>> e : ALIASES.entrySet()) {
            String alt = e.getValue().stream().map(Pattern::quote)
                    .reduce((a, b) -> a + "|" + b).orElse("");
            // Boundaries that tolerate the punctuation these names actually carry (c++, .net,
            // node.js). \b would refuse to match "c++" at all, which is how a C++ job reads as
            // having no language requirement.
            PATTERNS.put(e.getKey(), Pattern.compile("(?<![a-z0-9])(?:" + alt + ")(?![a-z0-9])",
                    Pattern.CASE_INSENSITIVE));
        }
    }

    /**
     * Only what the text NAMES — no implied languages added.
     *
     * The distinction matters for counting. "React" implies JavaScript, so a posting that says
     * React alone would otherwise register as TWO matches against a React developer, and two
     * matches is the bar for accepting a job outright. That let a Python/FastAPI backend
     * through on its React front end. Overlap is counted on what a posting explicitly asks for;
     * implications are used only to decide whether a requirement is met.
     */
    public static Set<String> extractExplicit(String text) {
        if (text == null || text.isBlank()) return Set.of();
        String t = text.toLowerCase(Locale.ROOT);
        Set<String> found = new LinkedHashSet<>();
        for (Map.Entry<String, Pattern> e : PATTERNS.entrySet()) {
            if (e.getValue().matcher(t).find()) found.add(e.getKey());
        }
        return found;
    }

    /** Every technology named in the text, canonicalised, with implied languages added. */
    public static Set<String> extract(String text) {
        if (text == null || text.isBlank()) return Set.of();
        String t = text.toLowerCase(Locale.ROOT);
        Set<String> found = new LinkedHashSet<>();
        for (Map.Entry<String, Pattern> e : PATTERNS.entrySet()) {
            Matcher m = e.getValue().matcher(t);
            if (m.find()) found.add(e.getKey());
        }
        // A job that says "Spring Boot" requires Java whether or not it says the word.
        for (String f : new ArrayList<>(found)) {
            String implied = IMPLIES.get(f);
            if (implied != null) found.add(implied);
        }
        return found;
    }

    /** Of these technologies, the ones that decide whether a job is plausible. */
    public static Set<String> core(Set<String> all) {
        Set<String> out = new LinkedHashSet<>();
        for (String s : all) if (CORE.contains(s)) out.add(s);
        return out;
    }

    /** Human-readable name for a canonical key, for the reason strings the owner reads. */
    public static String label(String key) {
        return switch (key) {
            case "csharp" -> "C#/.NET";
            case "cpp" -> "C++";
            case "golang" -> "Go";
            case "node" -> "Node.js";
            case "nextjs" -> "Next.js";
            case "nestjs" -> "NestJS";
            case "reactnative" -> "React Native";
            case "dotnetcore" -> ".NET Core";
            case "javascript" -> "JavaScript";
            case "typescript" -> "TypeScript";
            case "mongodb" -> "MongoDB";
            case "sql" -> "SQL";
            case "aws" -> "AWS";
            case "gcp" -> "GCP";
            case "ios" -> "iOS";
            case "abap" -> "ABAP";
            case "rpg" -> "RPG";
            case "sap" -> "SAP";
            default -> key.substring(0, 1).toUpperCase(Locale.ROOT) + key.substring(1);
        };
    }
}
