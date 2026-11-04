//! The 66-book canon with English and Tagalog names, plus the abbreviations
//! used in printed lessons. Lookup keys are lowercase with no spaces or dots.

pub struct Book {
    pub id: u32,
    pub en: &'static str,
    pub tl: &'static str,
    pub aliases: &'static [&'static str],
}

macro_rules! b {
    ($id:expr, $en:expr, $tl:expr, [$($a:expr),*]) => {
        Book { id: $id, en: $en, tl: $tl, aliases: &[$($a),*] }
    };
}

pub static BOOKS: &[Book] = &[
    b!(1, "Genesis", "Genesis", ["gen", "gn"]),
    b!(2, "Exodus", "Exodo", ["exod", "exo", "ex"]),
    b!(3, "Leviticus", "Levitico", ["lev", "lv"]),
    b!(4, "Numbers", "Mga Bilang", ["num", "bilang", "bil", "blg", "mgabilang"]),
    b!(5, "Deuteronomy", "Deuteronomio", ["deut", "dt", "deu"]),
    b!(6, "Joshua", "Josue", ["josh", "jos"]),
    b!(7, "Judges", "Mga Hukom", ["judg", "jdg", "hukom", "huk", "mgahukom"]),
    b!(8, "Ruth", "Ruth", ["rut"]),
    b!(9, "I Samuel", "I Samuel", ["1samuel", "1sam", "1sa"]),
    b!(10, "II Samuel", "II Samuel", ["2samuel", "2sam", "2sa"]),
    b!(11, "I Kings", "I Hari", ["1kings", "1kgs", "1ki", "1hari", "1har"]),
    b!(12, "II Kings", "II Hari", ["2kings", "2kgs", "2ki", "2hari", "2har"]),
    b!(13, "I Chronicles", "I Cronica", ["1chronicles", "1chron", "1chr", "1cronica", "1cron", "1cro"]),
    b!(14, "II Chronicles", "II Cronica", ["2chronicles", "2chron", "2chr", "2cronica", "2cron", "2cro"]),
    b!(15, "Ezra", "Ezra", ["ezr"]),
    b!(16, "Nehemiah", "Nehemias", ["neh"]),
    b!(17, "Esther", "Esther", ["est", "esth", "ester"]),
    b!(18, "Job", "Job", []),
    b!(19, "Psalms", "Awit", ["psalm", "ps", "psa", "pss", "mgaawit", "aw"]),
    b!(20, "Proverbs", "Kawikaan", ["prov", "prv", "pro", "kaw", "mgakawikaan"]),
    b!(21, "Ecclesiastes", "Eclesiastes", ["eccl", "ecc", "ecles", "ec"]),
    b!(22, "Song of Solomon", "Awit ng mga Awit", ["song", "sos", "awitngmgaawit", "awit ng mga awit"]),
    b!(23, "Isaiah", "Isaias", ["isa", "is"]),
    b!(24, "Jeremiah", "Jeremias", ["jer"]),
    b!(25, "Lamentations", "Panaghoy", ["lam", "pan", "panag"]),
    b!(26, "Ezekiel", "Ezekiel", ["ezek", "eze", "ezk", "ezequiel"]),
    b!(27, "Daniel", "Daniel", ["dan"]),
    b!(28, "Hosea", "Oseas", ["hos", "ose"]),
    b!(29, "Joel", "Joel", []),
    b!(30, "Amos", "Amos", ["am"]),
    b!(31, "Obadiah", "Obadias", ["obad", "oba"]),
    b!(32, "Jonah", "Jonas", ["jon"]),
    b!(33, "Micah", "Mikas", ["mic", "mik", "miqueas"]),
    b!(34, "Nahum", "Nahum", ["nah"]),
    b!(35, "Habakkuk", "Habacuc", ["hab"]),
    b!(36, "Zephaniah", "Sofonias", ["zeph", "zep", "sof"]),
    b!(37, "Haggai", "Hagai", ["hag"]),
    b!(38, "Zechariah", "Zacarias", ["zech", "zec", "zac"]),
    b!(39, "Malachi", "Malakias", ["mal"]),
    b!(40, "Matthew", "Mateo", ["matt", "mat", "mt"]),
    b!(41, "Mark", "Marcos", ["mar", "mrk", "mk", "marc"]),
    b!(42, "Luke", "Lucas", ["luk", "lk", "luc"]),
    b!(43, "John", "Juan", ["jn", "jhn"]),
    b!(44, "Acts", "Mga Gawa", ["act", "gawa", "mgagawa"]),
    b!(45, "Romans", "Roma", ["rom", "ro"]),
    b!(46, "I Corinthians", "I Corinto", ["1corinthians", "1cor", "1co", "1corinto"]),
    b!(47, "II Corinthians", "II Corinto", ["2corinthians", "2cor", "2co", "2corinto"]),
    b!(48, "Galatians", "Galacia", ["gal", "ga"]),
    b!(49, "Ephesians", "Efeso", ["eph", "efe", "ef"]),
    b!(50, "Philippians", "Filipos", ["phil", "php", "fil"]),
    b!(51, "Colossians", "Colosas", ["col"]),
    b!(52, "I Thessalonians", "I Tesalonica", ["1thessalonians", "1thess", "1thes", "1th", "1tesalonica", "1tes"]),
    b!(53, "II Thessalonians", "II Tesalonica", ["2thessalonians", "2thess", "2thes", "2th", "2tesalonica", "2tes"]),
    b!(54, "I Timothy", "I Timoteo", ["1timothy", "1tim", "1ti", "1timoteo"]),
    b!(55, "II Timothy", "II Timoteo", ["2timothy", "2tim", "2ti", "2timoteo"]),
    b!(56, "Titus", "Tito", ["tit"]),
    b!(57, "Philemon", "Filemon", ["phlm", "phm", "philem", "flm", "filem"]),
    b!(58, "Hebrews", "Hebreo", ["heb"]),
    b!(59, "James", "Santiago", ["jas", "jam", "sant", "stgo"]),
    b!(60, "I Peter", "I Pedro", ["1peter", "1pet", "1pe", "1pedro", "1ped"]),
    b!(61, "II Peter", "II Pedro", ["2peter", "2pet", "2pe", "2pedro", "2ped"]),
    b!(62, "I John", "I Juan", ["1john", "1jn", "1juan", "1jhn"]),
    b!(63, "II John", "II Juan", ["2john", "2jn", "2juan", "2jhn"]),
    b!(64, "III John", "III Juan", ["3john", "3jn", "3juan", "3jhn"]),
    b!(65, "Jude", "Judas", ["jud"]),
    b!(66, "Revelation", "Apocalipsis", ["rev", "re", "revelations", "apoc", "apocalipsis", "apo"]),
];

pub fn by_id(id: u32) -> Option<&'static Book> {
    BOOKS.iter().find(|b| b.id == id)
}

/// Books that differ only by their series number, such as I and II Kings.
/// OCR confuses these numerals, so they can be cross-checked between lessons.
pub fn same_series(a: u32, b: u32) -> bool {
    const SERIES: &[&[u32]] = &[&[9, 10], &[11, 12], &[13, 14], &[46, 47], &[52, 53], &[54, 55], &[60, 61], &[62, 63, 64]];
    a != b && SERIES.iter().any(|s| s.contains(&a) && s.contains(&b))
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Resolve a book from an optional series number (1/2/3) and a name.
pub fn find(num: Option<u32>, name: &str) -> Option<&'static Book> {
    let n = norm(name);
    if n.is_empty() {
        return None;
    }
    let key = match num {
        Some(k) => format!("{k}{n}"),
        None => n,
    };
    BOOKS.iter().find(|b| {
        norm_full(b.en) == key
            || norm_full(b.tl) == key
            || b.aliases.iter().any(|a| norm(a) == key)
    })
}

fn norm_full(s: &str) -> String {
    let n = norm(s);
    if let Some(r) = n.strip_prefix("iii") {
        format!("3{r}")
    } else if let Some(r) = n.strip_prefix("ii") {
        format!("2{r}")
    } else if let Some(r) = n.strip_prefix('i') {
        // Only series-numbered names begin with a roman "I " in the canon table.
        if s.starts_with("I ") {
            format!("1{r}")
        } else {
            n
        }
    } else {
        n
    }
}
