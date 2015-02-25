"use strict"

var DIM_CACHE = {};
var DATA_CACHE = {};
var DATA_CACHE_KEYS = [];
var MAX_DATA = 10;
var DRILL_CACHE = {};
var PAGE_LENGTH = 100;

// Simple helper
var identity = function(x) {return x;}

// Force waiting cursor when an ajax call is in progress
$.ajaxSetup({
    'beforeSend': function(jqXHR, settings) {
        $('html').addClass('wait');
    },
    'complete': function(jqXHR, settings) {
        $('html').removeClass('wait');
    }
});

var Space = function(name, label) {
    this.name = name;
    this.label = label;
};


var Measure = function(space, name, label) {
    this.space = space;
    this.name = this.space.name + '.' + name;
    this.label = label;
    this.fullname = this.space.label +' / ' + this.label;
};


var Coordinate = function(dimension, parent, value, label) {
    this.value = value;
    this.parent = parent;
    this.dimension = dimension;
    this.active = ko.observable(false);
    this.children = [];
    this.label = label || dimension.label;
};

Coordinate.prototype.drill = function(value) {
    var query = {
        'space': this.dimension.dimsel.dataset.measures()[0].space.name,
        'dimension': this.dimension.name,
        'value': this.value,
    }

    query = JSON.stringify(query);
    var callback = function(res) {
        this.add_children(res.data);
        this.dimension.selected_coord(this);
    }.bind(this)

    if (query in DRILL_CACHE) {
        callback(DRILL_CACHE[query])
        return $.when();
    }

    var url = '/mng/drill.json?' + $.param({'query': query});
    var prm = $.ajax(url)
    prm.then(function(res) {
        DRILL_CACHE[query] = res;
        callback(res);
    });
    return prm;
};

Coordinate.prototype.add_children = function(names) {
    var children = [];
    for (var pos in names) {
        var name = names[pos];
        var value = this.value.slice();
        value.push(name[0]);
        var child = new Coordinate(this.dimension, this, value, name[1]);
        children.push(child);
    }
    this.children = children;
};

Coordinate.prototype.activate = function() {
    if (this.active()) {
        this.active(false);
        return;
    }

    this.dimension.choice().forEach(function(d) {
        d.active(false);
    }.bind(this))
    this.active(true);
};

Coordinate.prototype.has_children = function() {
    return this.value.length < this.dimension.levels().length;
};

Coordinate.prototype.set_value = function(value) {
    if (!value || !value.length) {
        return;
    }

    var prm = this.drill();
    if (!value[0]) {
        // If level as been selected enforce it, else select root level
        var l = value.length;
        var idx =  l > 1 ? l-1 : 0;
        this.dimension.dimsel.level_index(idx);

        prm.then(function() {
            this.dimension.selected_coord(this);
        }.bind(this));
        return prm;
    }

    var chained_prm = prm.then(function() {
        for (var pos in this.children) {
            var child = this.children[pos];
            var last_val = child.value[child.value.length - 1];
            if (last_val != value[0]) {
                continue;
            }

            value = value.splice(1);
            if (value.length) {
                return child.set_value(value);
            }
            child.activate();
            break;
        }
    }.bind(this));
    return chained_prm;
};


var Dimension = function(name, label, levels, dimsel) {
    this.name = name;
    this.label = label;
    this.dimsel = dimsel;
    this.active = ko.observable(false);
    this.selected_coord = ko.observable();
    this.levels = ko.observable(levels);
};

Dimension.prototype.choice = function() {
    if (!this.selected_coord()) {
        return [];
    }
    return this.selected_coord().children;
};

Dimension.prototype.has_children = function() {
    return true;
};

Dimension.prototype.drill = function() {
    this.activate();
    var root = new Coordinate(this, null, []);
    this.selected_coord(root);
    root.drill();
};

Dimension.prototype.activate = function() {
    var old = this.dimsel.selected_dim();
    old && old.active(false);
    this.dimsel.selected_dim(this);
    this.active(true);
};

Dimension.prototype.drill_up = function() {
    this.selected_coord(this.selected_coord().parent);
};

Dimension.prototype.set_value = function(value) {
    var root = new Coordinate(this, null, []);
    this.selected_coord(root);
    // Clean extra item if value is too long (needed when two measures
    // work on different depths)
    var tail = value.splice(this.levels().length)
    if (tail.length) {
        // value has been cut, show the last level in full
        value[value.length -1] = null;
    }
    return root.set_value(value);
}

Dimension.prototype.get_value = function() {
    var coord = this.selected_coord() || new Coordinate(this, null, []);

    if (coord) {
        var actives = this.choice().filter(function(d) {
            return d.active();
        });
        var value;
        if (actives.length) {
            value = actives[0].value.slice();
        } else {
            value = coord.value.slice();
            value.push(null);
        }
        for (var i = value.length; i <= this.dimsel.level_index(); i++) {
            value.push(null);
        }
        return value;
    }
    return [null];
};

// Small object to hold a search result used when the user filter on
// the dimension
var SearchItem = function(name, depth, dim_sel) {
    this.name = name;
    this.depth = depth;
    this.level = dim_sel.selected_dim().levels()[depth - 1];
    this.dim_sel = dim_sel;
    this.active = ko.observable(false);
};

SearchItem.prototype.select = function() {
    var changed = this.dim_sel.filter_item() !== this;
    this.active(changed);

    if (changed && this.dim_sel.filter_item()) {
        this.dim_sel.filter_item().active(false);
    }
    this.dim_sel.filter_item(changed ? this : null);
};


var DimSelect = function(dataset, dim_name, dim_value, pivot) {
    this.dataset = dataset;
    this.selected_dim = ko.observable();
    this.card = ko.observable('main'); // can be 'filter' or 'option'
    this.dimensions = ko.observable();
    this.level_index = ko.observable(0);
    this.pivot = ko.observable(pivot);
    this.head_levels = ko.observable([]);
    this.tail_levels = ko.observable([]);
    this.prm = this.set_dimensions(
        dataset.available_dimensions(),
        dim_name,
        dim_value);
    this.search_results = ko.observable([]);
    this.current_search = ko.observable('');
    this.filter_item = ko.observable();

    this.choice = ko.computed(function() {
        var selected_dim = this.selected_dim();
        if (selected_dim.selected_coord()){
            return selected_dim.choice();
        }
        return this.dimensions();
    }.bind(this));

    this.label = ko.computed(function() {
        var dim = this.selected_dim();
        return dim ? dim.label : '?';
    }.bind(this));

    this.selected_dim.subscribe(function() {
        // Reset level index if active dimension change
        this.level_index(0);
        // Reset current_search
        this.current_search('');
        // Reset filter_item
        this.filter_item() && this.filter_item().active(false);
        this.filter_item(null);
    }.bind(this));

    // Update Levels
    ko.computed(function() {
        var dim = this.selected_dim();
        if (!dim) {
            this.head_levels([]);
            this.tail_levels([]);
            return;
        }
        var heads = [];
        var tails = [];
        var depth = 0;
        var coord = dim.selected_coord();
        if (coord) {
            depth = coord.value.length;
        }

        dim.levels().slice(depth).forEach(function(name, pos) {
            var level = new Level(name, depth+pos, this);
            // If more than two levels, put them in dropdown (tail)
            if (pos < 2) {
                heads.push(level);
            } else {
                tails.push(level);
            }
        }.bind(this));

        this.head_levels(heads);
        this.tail_levels(tails);
    }.bind(this));

    // Put search query in a computed to allow throttling
    ko.computed(function() {
        // Filter search results based on user input
        var cs = this.current_search().trim();
        if (!cs || !cs.length) {
            this.search_results([]);
            return;
        }

        var query = {
            'space': this.dataset.measures()[0].space.name,
            'dimension': this.selected_dim().name,
            'value': cs,
        }
        query = JSON.stringify(query);

        var url = '/mng/search.json?' +  $.param({'query': query});
        $.get(url).then(function(resp) {
            var results = []
            for (var pos in resp.data) {
                var name = resp.data[pos][0];
                var depth = resp.data[pos][1];
                var search_item = new SearchItem(name, depth, this);
                results.push(search_item);
            }

            this.search_results(results);
        }.bind(this));
    }, this).extend({'throttle': 300});

    this.search_results.subscribe(function() {
        // Auto select matching item if results are updated
        var fi = this.filter_item();
        if (!fi) {
            return;
        }

        var found = null;
        var sr = this.search_results();
        for (var pos in sr) {
            if (fi.name == sr[pos].name && fi.depth == sr[pos].depth) {
                found = true
                sr[pos].select()
                break;
            }
        }
        if (!found) {
            this.filter_item(null);
        }
    }.bind(this));

};

DimSelect.prototype.set_dimensions = function(available, dim_name, dim_value) {
    var clones = available.map(function (d) {
        var clone = new Dimension(d.name, d.label, d.levels(), this);
        return clone;
    }.bind(this));
    this.dimensions(clones);

    // Search the clone matching dim_name
    var clone = null;
    for (var pos in clones) {
        if (clones[pos].name == dim_name) {
            clone = clones[pos];
            break;
        }
    }

    // No match on dim_name: pick the first
    if (!clone) {
        clones[0].activate();
        return;
    }

    // update clone with the correct value and return the
    // corresponding promise
    clone.activate();
    var prm = $.when();
    if (dim_value) {
        prm = clone.set_value(dim_value);
    }
    return prm;
};

DimSelect.prototype.get_filter_item = function() {
    var fi = this.filter_item();
    if (!fi) {
        return null;
    }
    return [this.selected_dim().name, fi.name, fi.depth];
};

DimSelect.prototype.click_option = function(dim_select, ev) {
    // Show current collapsible
    var target = $(ev.target);
    var heading = target.parents('.panel-heading');
    var collapse = heading.next('.panel-collapse');

    var test = this.card() != 'option' || !collapse.hasClass('in');
    this.card(test ? 'option' : 'main');
    collapse.collapse('show');
};

DimSelect.prototype.click_search = function(dim_select, ev) {
    // Show current collapsible
    var target = $(ev.target);
    var heading = target.parents('.panel-heading');
    var collapse = heading.next('.panel-collapse');

    var test = this.card() != 'search' || !collapse.hasClass('in');
    this.card(test ? 'search' : 'main');
    collapse.collapse('show');
};

DimSelect.prototype.click_clear_search = function(dim_select, ev) {
    this.current_search('');
};

DimSelect.prototype.drill_up = function(dim_select, ev) {
    // Show current collapsible
    var target = $(ev.target);
    var heading = target.parents('.panel-heading');
    var collapse = heading.next('.panel-collapse');
    collapse.collapse('show');
    // drill up and force main card
    this.selected_dim().drill_up();
    this.card('main');
};

DimSelect.prototype.can_drill_up = function() {
    return this.selected_dim().selected_coord();
};

DimSelect.prototype.move_up = function() {
    var dim_selects = this.dataset.dim_selects();
    var pos = dim_selects.indexOf(this)
    if (pos < 1) {
        return;
    }
    // Remove
    dim_selects.splice(pos, 1);
    // Re-add this one position before
    dim_selects.splice(pos-1, 0, this);
    this.dataset.dim_selects(dim_selects)
};

DimSelect.prototype.move_down = function() {
    var dim_selects = this.dataset.dim_selects();
    var pos = dim_selects.indexOf(this)
    if (pos < 0 || pos >= dim_selects.length - 1) {
        return;
    }
    // Remove this
    dim_selects.splice(pos, 1);
    // Re-add this one position after
    dim_selects.splice(pos+1, 0, this);
    this.dataset.dim_selects(dim_selects)
};

DimSelect.prototype.remove = function() {
    var dim_selects = this.dataset.dim_selects();
    var pos = dim_selects.indexOf(this)
    if (pos < 0) {
        return;
    }
    // Remove this
    dim_selects.splice(pos, 1);
    this.dataset.dim_selects(dim_selects)
};


var Level = function(name, index, dimsel) {
    this.name = name;
    this.index = index;
    this.dimsel = dimsel;

    this.active = ko.computed(function() {
        return dimsel.level_index() == index;
    })
};

Level.prototype.activate = function() {
    var idx = this.index == this.dimsel.level_index() ? 0 : this.index;
    this.dimsel.level_index(idx);
};


var DataSet = function(json_state) {
    this.measures =  ko.observableArray([]);
    this.available_measures = ko.observable([]);
    this.dim_selects = ko.observableArray([]);
    this.available_dimensions = ko.observable([]);
    this.table_data = ko.observable();
    this.graph_data = ko.observable();
    this.limit = ko.observable(PAGE_LENGTH);
    this.columns = ko.observable([]);
    this.totals = ko.observable([]);
    this.json_state = ko.observable();
    this.state = {};
    this.ready = ko.observable(false);
    this.skip_zero = ko.observable(true);
    this.show_menu = ko.observable(true);
    this.active_view = ko.observable('table');
    this.chart_type = ko.observable('table');
    this.available_charts = ko.observable([]);
    this.error = ko.observable();

    // Populate available charts
    var av_ch = [];
    for (var key in CHARTS) {
        av_ch.push({
            'key': key,
            'label': CHARTS[key].label,
        });
    }
    this.available_charts(av_ch);

    // Clear vis area to avoid clash between different graph type
    this.chart_type.subscribe(function() {
        $("#vis").empty();
    });


    // fetch meta-data and init state
    $.get('/mng/info.json').then(function(info) {
        this.set_info(info);
        this.set_state(json_state);
    }.bind(this));

    this.measures.subscribe(this.measures_changed.bind(this));

    // compute state
    ko.computed(this.refresh_state.bind(this)).extend({
        'rateLimit': 10,
    });

    // get_data returns slice of data that increase with this.limit()
    this.get_data = ko.computed(function() {
        var res = this.table_data();
        if (res && res.length > this.limit()) {
            return res.slice(0, this.limit());
        }
        return res;
    }, this);

    this.table_data.subscribe(function() {
        this.limit(PAGE_LENGTH);
    }, this);


    window.onscroll = function(ev) {
        var full_height = document.body.offsetHeight;
        var position = window.innerHeight + window.scrollY;
        var near_bottom = position >= full_height * 0.9;
        if (this.table_data() && near_bottom && this.table_data().length > this.limit()) {
            this.limit(this.limit() + PAGE_LENGTH);
        }
    }.bind(this);

    this.columns_headers = ko.computed(function() {
        // Collect parent title for all columns
        var columns = this.columns();
        var res = [];
        var name_found = null;
        for (var pos in columns) {
            var name = columns[pos].parent;
            name_found = name_found || (name && name.length);
            if (res.length > 0 && name == res[res.length-1].name) {
                res[res.length-1].colspan += 1;
                continue;
            }
            res.push({
                'name': name, 'colspan': 1, 'type': 'group',
            });
        }

        if (!name_found) {
            // Avoid to display an empty line
            return []
        }
        return res;
    }.bind(this));

};

DataSet.prototype.toggle_show_menu = function() {
    this.show_menu(!this.show_menu());
};

DataSet.prototype.set_active_view = function(obj, ev, chart_type) {
    var view = ev.target.href.split('#')[1];
    this.active_view(view);
    if (chart_type) {
        this.chart_type(chart_type);
    }
};

DataSet.prototype.push_dim_select = function() {
    var av = this.available_dimensions();
    var currents = this.dim_selects().map(function(ds) {
        return ds.selected_dim().name;
    });
    var dim_name;
    // var dim_value = [null];
    for (var pos in av) {
        var name = av[pos].name;
        if (currents.indexOf(name) < 0) {
            dim_name = name;
            break;
        }
    }

    var dsel = new DimSelect(this, dim_name);
    this.dim_selects.push(dsel);
    return dsel;
};

DataSet.prototype.select_measure = function(selected, pos) {
    var msr = this.measures()
    msr[pos] = selected;
    this.measures(msr);
};

DataSet.prototype.push_measure = function() {
    var av = this.available_measures();
    var currents = this.measures().map(function(m) {
        return m.name;
    });

    // Search for a measure that is not already selected
    for (var pos in av) {
        var name = av[pos].name;
        if (currents.indexOf(name) < 0) {
            this.measures.push(av[pos]);
            return;
        }
    }

    // Every measure already selected, pick the first
    this.measures.push(av[0]);
};

DataSet.prototype.pop_measure = function() {
    this.measures.pop();
};

DataSet.prototype.pop_dim_select = function() {
    this.dim_selects.pop()
};

DataSet.prototype.set_info = function(info) {
    var spaces = info.spaces;

    for (var pos in spaces) {
        var spc = spaces[pos]
        var dimensions = [];
        for (var pos in spc.dimensions) {
            var dim = spc.dimensions[pos];
            dimensions.push(new Dimension(dim.name, dim.label, dim.levels));
        }
        DIM_CACHE[spc.name] = dimensions;
    }

    var measures = [];
    for (var pos in spaces) {
        var spc = spaces[pos];
        var space = new Space(spc.name, spc.label);
        for (var pos in spc.measures) {
            var msr = spc.measures[pos];
            measures.push(new Measure(space, msr.name, msr.label));
        }
    }
    this.available_measures(measures);
};

DataSet.prototype.get_dim_selects = function(dims) {
    var pivot_on = this.state.pivot_on || [];
    return dims.map(function(d, pos) {
        var pivot = pivot_on.indexOf(pos) > -1;
        return new DimSelect(this, d[0], d[1], pivot);
    }.bind(this));
};

DataSet.prototype.measures_changed = function(measures) {
    var dimensions = DIM_CACHE[measures[0].space.name] || [];
    // Filter dimensions that are available for all measures
    for (var pos=1; pos < measures.length; pos++) {
        var others = DIM_CACHE[measures[pos].space.name]
        var unfiltered = dimensions.slice();
        dimensions = [];
        for (var x in unfiltered) {
            var dim = unfiltered[x];
            var candidate = null;
            for (var y in others) {
                var other = others[y];
                if (dim.name == other.name) {
                    // Keep the shallowest dimension
                    if (other.levels().length < dim.levels().length) {
                        dimensions.push(other);
                    } else {
                        dimensions.push(dim);
                    }
                    break;
                }
            }
        }
    }

    this.available_dimensions(dimensions);
    this.refresh_dimensions();
};

DataSet.prototype.refresh_measures = function() {
    var measures = [];
    if (this.state.measures) {
        measures = this.available_measures().filter(function(m) {
            return this.state.measures.indexOf(m.name) >= 0;
        }.bind(this));
    } else if (this.available_measures().length) {
         measures = [this.available_measures()[0]];
    }
    this.measures(measures);
};

DataSet.prototype.refresh_dimensions = function() {
    // Clean active dimensions
    var current_selects = this.dim_selects();
    if (!current_selects) {
        current_selects = [];
    }

    // Index dimensions per name
    var availables = {};
    this.available_dimensions().forEach(function(d) {
        availables[d.name] = d;
    });

    for (var pos in current_selects) {
        var current_select = current_selects[pos];
        var current_dim = current_select.selected_dim();
        var av_dim = availables[current_dim.name];
        if (!av_dim) {
            current_selects.splice(pos, 1);
        } else {
            current_select.set_dimensions(
                this.available_dimensions(),
                current_dim.name,
                current_dim.get_value()
            );
            current_dim.levels(av_dim.levels());
        }
    }

    // If dimensions remain, return ..
    if (current_selects.length) {
        this.dim_selects(current_selects)
        this.ready(true);
        return;
    }

    // .. if not, build them based on current state
    var state_dimensions = this.state.dimensions || [];
    state_dimensions = state_dimensions.filter(function(n) {
        return n[0] in availables;
    });
    if (state_dimensions.length) {
        var dim_selects = this.get_dim_selects(state_dimensions);
        // update this.dim_selects only when all are ready
        var prms = dim_selects.map(function(d) {return d.prm});
        $.when.apply(this, prms).then(function() {
            this.dim_selects(dim_selects);
            this.ready(true);
        }.bind(this));

    } else {
        // Show at least one dimension
        this.push_dim_select();
        this.ready(true);
    }
}

DataSet.prototype.set_state = function(state) {
    state = state || {};
    this.ready(false);
    var sz = state.skip_zero === undefined || state.skip_zero;
    this.skip_zero(sz);
    this.state = state || {};
    // Reset data
    this.dim_selects([]);
    this.refresh_measures();
};

DataSet.prototype.refresh_state = function() {
    if (!this.ready()) {
        return;
    }

    var dim_sels = this.dim_selects();
    var msrs = this.measures();
    if (!(dim_sels.length && msrs.length)) {
        return;
    }

    var pivot_on = [];
    dim_sels.forEach(function(ds, pos) {
        if (ds.pivot()) {
            pivot_on.push(pos);
        }
    })

    this.state = {
        'measures': msrs.map(function(m) {return m.name}),
        'dimensions': dim_sels.map(function(dsel) {
            var dimension = dsel.selected_dim();
            var value = dimension.get_value();
            return [dimension.name, value]
        }),
        'skip_zero': this.active_view() == 'graph'? false : this.skip_zero(),
        'pivot_on': pivot_on,
        'filters': dim_sels.map(function(dsel) {
            return dsel.get_filter_item();
        }).filter(identity),
    }
    this.json_state(JSON.stringify(this.state));

    var hash = '#' + btoa(this.json_state());
    if (window.location.hash != hash) {
        window.history.pushState(this.json_state(), "Title", hash);
    }

    var ext = this.active_view() == 'table' ? 'txt' : 'json';
    var url = this.dice_url(ext);
    var prm = this.fetch_data(url);
    prm.then(function(res) {
        this.error(res.error);
    }.bind(this));

    if (this.active_view() == 'table') {
        prm.then(function(res) {
            this.cache_data(url, res);
            // Update dataset
            this.table_data(res.data);
            this.columns(res.columns);
            this.totals(res.totals);
        }.bind(this));
    } else if (this.active_view() == 'graph') {

        var chart_type = this.chart_type();
        var chart_class = CHARTS[chart_type];
        prm.then(function(res) {
            this.cache_data(url, res);
            // Pick chart
            var graph_min_dim = chart_class.graph_min_dim;
            var graph_max_dim = chart_class.graph_max_dim;

            // Count dimensions
            var nb_dim = 0;
            for (var pos in dim_sels) {
                var dim = dim_sels[pos].selected_dim();
                // Frozen dimensions are not included in results
                // TODO s/active/frozen/ -> on coordinate object
                if (dim.get_value().indexOf(null) >= 0) {
                    nb_dim++;
                }
            }

            // Show error if dimension number mismatch
            var vis = $("#vis");
            if (nb_dim > graph_max_dim) {
                vis.html('<p>Too many dimensions</p>')
                return;
            } else if (nb_dim < graph_min_dim) {
                vis.html('<p>Not enough dimensions</p>')
                return;
            } else {
                vis.find('p').remove();
            }

            // Wrapper to instanciate new chart (and not reuse the
            // same instance)
            var get_chart = function() {
                var chart = chart_class.chart();
                chart.x(function(d) {return d[0]})
                    .y(function(d) {return d[nb_dim]});

                this.show_menu.subscribe(function() {chart.update()});
                return chart;
            }.bind(this);


            // Nest on extra dimensions
            var nest = d3.nest();
            chart_class.nesting(nest, nb_dim);
            var data = nest.entries(res.data);

            // Define nested charts
            nv.addGraph(function() {
                // create top-level join
                var vis = d3.select("#vis")

                var wrapper = vis.selectAll('.svg-wrapper')
                    .data(data);
                wrapper.enter().append('div');
                if (data.length == 1) {
                    wrapper.attr('class','svg-wrapper');
                } else {
                    wrapper.attr('class','svg-wrapper multi');
                }
                wrapper.exit().remove();

                var svg = wrapper.selectAll('svg')
                    .data(function(d) {return [d]})
                svg.enter().append("svg");
                svg.exit().remove();

                // call chart on each block
                svg.each(function(d) {
                    if (d.values.length > 6) {
                        $(this).find ('.nv-legendWrap').empty()
                    }
                    var chart = get_chart();
                    chart_class.update(chart, d.values.length, nb_dim);
                    d3.select(this).datum(d.values)
                        .transition().duration(500)
                        .call(chart);
                });


                var label = wrapper.selectAll('p.label')
                    .data(function(d,i){return [d]});
                // Force insertion before svg
                label.enter().insert('p', 'svg')
                label.exit().remove();
                label.attr('class', 'label')
                    .html(function(d) {return d.key;});


                return vis;
            });

        }.bind(this));
    }
};



DataSet.prototype.dice_url = function(ext) {
    return '/mng/dice.' + ext + '?' +  $.param({'query': this.json_state()});
}


DataSet.prototype.fetch_data = function(url) {
    var res = DATA_CACHE[url];
    if (res) {
        return $.when(res);
    } else {
        return $.ajax(url);
    }
};


DataSet.prototype.cache_data = function(json_state, res) {
    // Store in cache
    var is_new = !(json_state in DATA_CACHE);
    DATA_CACHE[json_state] = res;
    if (is_new) {
        DATA_CACHE_KEYS.push(json_state);
    }
    // Discard oldest items if dict gets too big
    if (DATA_CACHE_KEYS.length > MAX_DATA) {
        var discard = DATA_CACHE_KEYS.shift();
        delete DATA_CACHE[discard]
    }
};

DataSet.prototype.get_xlsx = function() {
    var url = this.dice_url('xlsx');
    window.location.href = url;
};


var CHARTS = {};

CHARTS.bar = {
    'chart': function() {
        var chart = nv.models.multiBarChart()
            .staggerLabels(true)
            .stacked(true)
        ;
        chart.yAxis
            .tickFormat(d3.format('.3s'));
        return chart;
    },
    'graph_min_dim': 1,
    'graph_max_dim': 3,
    'nesting' : function(nest, nb_dim) {
        switch(nb_dim) {
        case 1:
            nest.key(function(d) {return ""});
            nest.key(function(d) {return ""});
            break;
        case 2:
            nest.key(function(d) {return ""});
            nest.key(function(d) {return d[1]});
            break;
        case 3:
            nest.key(function(d) {return d[2]});
            nest.key(function(d) {return d[1]});
            break
        }
    },
    'label': "Bar Chart",
    'update': function(chart, nb_values, nb_dim) {
        chart.showLegend(nb_dim != 1 && nb_values <= 6);
    },
};

CHARTS.pie = {
    'chart': function() {
        return nv.models.pieChart()
            .showLabels(true);
    },
    'graph_min_dim': 1,
    'graph_max_dim': 2,
    'nesting' : function(nest, nb_dim) {
        switch(nb_dim) {
        case 1:
            nest.key(function(d) {return ""});
            break;
        case 2:
            nest.key(function(d) {return d[1]});
            break
        }
    },
    'label': "Pie Chart",
    'update': function(chart, nb_values, nb_dim) {
        chart.showLegend(nb_values <= 6);
    },
};


var get_state = function() {
    try {
        var json_string = atob(window.location.hash.slice(1));
        return JSON.parse(json_string);
    } catch(e) {
        return null;
    }
}


var init = function() {
    var json_state = get_state();
    var ds = new DataSet(json_state);
    window.onpopstate = function(event) {
        ds.set_state(get_state());
    }.bind(this);

    ko.applyBindings(ds, $('body')[0]);

};

$(init);
