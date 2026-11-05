//! Tells Tagalog from English by how many of a text's words are common words of each.
//! Translation codes cannot decide this: Tagalog renderings are filed under codes such as
//! MSG and AMP, sometimes next to an English row with the same code.

const TAGALOG: &[&str] = &[
    "ang", "ng", "sa", "na", "mga", "at", "ay", "kayo", "ako", "siya", "ko", "mo", "niya", "nila", "namin", "natin", "ninyo",
    "ka", "hindi", "para", "kung", "kanyang", "kaniyang", "inyong", "akin", "dahil", "upang", "si", "ni", "ito", "isang",
];
const ENGLISH: &[&str] = &[
    "the", "and", "of", "to", "in", "you", "that", "is", "he", "for", "his", "with", "they", "are", "was", "will", "be", "your",
    "we", "not", "my", "it", "i", "as", "all", "who", "but", "have", "from", "this", "our",
];

const MIN_SHARE: f64 = 0.15;
const MIN_MARGIN: f64 = 0.12;

pub struct Detected {
    pub language: &'static str,
    /// False when the text has too few common words to be sure.
    pub confident: bool,
}

pub fn detect(text: &str) -> Detected {
    let words: Vec<String> = text.split(|c: char| !c.is_alphabetic() && c != '\'').filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    let share = |list: &[&str]| words.iter().filter(|w| list.contains(&w.as_str())).count() as f64 / words.len().max(1) as f64;
    let (tagalog, english) = (share(TAGALOG), share(ENGLISH));
    Detected {
        language: if english > tagalog { "en" } else { "tl" },
        confident: tagalog.max(english) >= MIN_SHARE && (tagalog - english).abs() >= MIN_MARGIN,
    }
}

pub fn is_tagalog(text: &str) -> bool {
    detect(text).language == "tl"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_language_is_recognised() {
        let tagalog = detect("Sapagkat ang mga tao ay naniniwala sa kaniyang salita at hindi sila natakot.");
        assert_eq!((tagalog.language, tagalog.confident), ("tl", true));
        let english = detect("So we continue to tell all of the people about the one who made them.");
        assert_eq!((english.language, english.confident), ("en", true));
    }

    #[test]
    fn too_little_to_go_on_is_not_confident() {
        assert!(!detect("Jerusalem Bethlehem Galilee").confident);
        assert!(!detect("").confident);
    }
}
