#[cfg(test)]
mod tests {
    use glib::variant::ToVariant;

    #[test]
    fn string_iteration_survives_optimized_ffi_calls() {
        let variant = vec!["one", "two", "three"].to_variant();
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some("one"));
        assert_eq!(iter.next_back(), Some("three"));
        assert_eq!(iter.next(), Some("two"));
        assert_eq!(iter.next(), None);
    }
}
