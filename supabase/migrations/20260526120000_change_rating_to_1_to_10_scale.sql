-- Migrate items.rating from a 1-5 whole-star scale to a 1-10 half-star
-- scale. The new scale encodes halves as odd numbers and wholes as even:
--
--   stored value  visual rating
--          1           ½ star
--          2           1 star
--          3           1½ stars
--          4           2 stars
--          …            …
--          9           4½ stars
--         10           5 stars
--
-- Existing whole-star ratings are doubled in place so a stored 4
-- (= 4 visual stars on the old scale) becomes 8 (= 4 visual stars on
-- the new scale). The user's actual rating is preserved; only the
-- internal representation changes.
--
-- Order matters: drop the old constraint first so the UPDATE doesn't
-- transiently violate it (a doubled 5 → 10 would fail BETWEEN 1 AND 5).
--
-- Side effect: the UPDATE fires items_set_updated_at on every rated
-- row, bumping their updated_at to the migration timestamp. This is
-- acceptable for a one-time scale change and avoids the complexity of
-- disabling/re-enabling the trigger. Downstream queries ordered by
-- updated_at will see all rated rows surface to the top temporarily;
-- normal app writes will re-shuffle them within a session of use.

alter table public.items
    drop constraint items_rating_range_check;

update public.items
    set rating = rating * 2
    where rating is not null;

alter table public.items
    add constraint items_rating_range_check
        check (rating is null or rating between 1 and 10);
